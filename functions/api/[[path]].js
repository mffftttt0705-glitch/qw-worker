// ============================================================
//  QW电竞 - 完整后端 API (v6.3 完整无缺失版)
//  Cloudflare Pages Functions + D1 数据库
// ============================================================

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 8);
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

async function queryDB(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  if (params.length > 0) return await stmt.bind(...params).all();
  return await stmt.all();
}

async function runDB(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  if (params.length > 0) return await stmt.bind(...params).run();
  return await stmt.run();
}

async function getUserById(env, userId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [userId]);
  return (result.results && result.results[0]) || null;
}

function verifyAndGetUserId(authHeader) {
  if (!authHeader) return null;
  const parts = authHeader.split('.');
  if (parts.length !== 2) return null;
  return parts[1];
}

// ============================================================
//  用户认证
// ============================================================
async function handleRegister(env, body) {
  const { username, password, role, status } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) return errorResponse('用户名已存在');
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM users');
  const count = countResult.results?.[0]?.count || 0;
  const userId = String(100000 + count + 1);
  const userStatus = (role === 'handler' || role === 'dispatcher' || role === 'service') ? 'pending' : (status || 'active');
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status, avatar, level) VALUES (?, ?, ?, ?, 0, 0, ?, ?, 1)',
    [userId, username, password, role || 'boss', userStatus, '']
  );
  return jsonResponse({
    message: (role === 'handler' || role === 'dispatcher' || role === 'service') ? '注册成功，请等待管理员审核' : '注册成功',
    id: userId
  });
}

async function handleLogin(env, body) {
  const { username, password } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');
  const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在');
  if (user.password !== password) return errorResponse('密码错误');
  if (user.status === 'banned') return errorResponse('账号已被封禁');
  if ((user.role === 'handler' || user.role === 'dispatcher' || user.role === 'service') && user.status !== 'active') {
    return errorResponse('账号待审核，请等待管理员审核通过后再登录');
  }
  const token = generateId() + '.' + user.id;
  return jsonResponse({
    token,
    user: {
      id: user.id, username: user.username, role: user.role || 'boss',
      diamond: user.diamond || 0, balance: user.balance || 0,
      status: user.status || 'active', banner: user.banner || '',
      avatar: user.avatar || '', club_prefix: user.club_prefix || '',
      level: user.level || 1
    }
  });
}

async function handleGetMe(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const avatarResult = await queryDB(env, 'SELECT avatar_url FROM user_avatars WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  const avatar = avatarResult.results?.[0]?.avatar_url || user.avatar || '';
  const { password, ...rest } = user;
  rest.avatar = avatar;
  return jsonResponse(rest);
}

async function handleGetUserPublic(env, userId) {
  const result = await queryDB(env, 'SELECT id, username, role, diamond, level, status, avatar, banner FROM users WHERE id = ?', [userId]);
  const user = result.results && result.results[0];
  if (!user) return errorResponse('用户不存在', 404);
  return jsonResponse(user);
}

// ============================================================
//  用户管理（管理员）
// ============================================================
async function handleAdminGetUsers(env) {
  try {
    const result = await queryDB(env,
      'SELECT id, username, role, diamond, balance, status, created_at, banner, avatar, club_prefix, level FROM users ORDER BY created_at DESC'
    );
    return jsonResponse(result.results || []);
  } catch (err) {
    return errorResponse('获取用户列表失败: ' + err.message, 500);
  }
}

async function handleAdminToggleBan(env, targetUserId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在', 404);
  const newStatus = user.status === 'active' ? 'banned' : 'active';
  await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, targetUserId]);
  return jsonResponse({ success: true, message: '用户状态已更新' });
}

async function handleAdminResetPassword(env, targetUserId) {
  await runDB(env, 'UPDATE users SET password = "123456" WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '密码已重置为 123456' });
}

async function handleApproveHandler(env, targetUserId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler' && user.role !== 'dispatcher' && user.role !== 'service') {
    return errorResponse('该用户不是打手、派单员或客服', 403);
  }
  if (user.status !== 'pending') return errorResponse('该用户不需要审核');
  await runDB(env, 'UPDATE users SET status = "active" WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '审核通过' });
}

async function handleChangeUsername(env, targetUserId, body) {
  const { username } = body;
  if (!username) return errorResponse('请输入新用户名');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ? AND id != ?', [username, targetUserId]);
  if (existing.results && existing.results.length > 0) return errorResponse('用户名已被使用');
  await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [username, targetUserId]);
  return jsonResponse({ success: true, message: '用户名已修改' });
}

async function handleAdminDeleteUser(env, targetUserId) {
  const user = await getUserById(env, targetUserId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role === 'admin') return errorResponse('不能删除管理员', 403);
  await runDB(env, 'DELETE FROM user_avatars WHERE user_id = ?', [targetUserId]);
  await runDB(env, 'DELETE FROM posts WHERE user_id = ?', [targetUserId]);
  await runDB(env, 'DELETE FROM post_comments WHERE user_id = ?', [targetUserId]);
  await runDB(env, 'DELETE FROM post_likes WHERE user_id = ?', [targetUserId]);
  await runDB(env, 'DELETE FROM messages WHERE sender_id = ? OR receiver_id = ?', [targetUserId, targetUserId]);
  await runDB(env, 'DELETE FROM message_contacts WHERE user_id = ? OR contact_id = ?', [targetUserId, targetUserId]);
  await runDB(env, 'DELETE FROM users WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '用户已删除' });
}

// ============================================================
//  修改用户ID（新用户迁移方案）
// ============================================================
async function handleChangeUserId(env, authHeader, body) {
  const adminId = verifyAndGetUserId(authHeader);
  if (!adminId) return errorResponse('请先登录', 401);
  const admin = await getUserById(env, adminId);
  if (!admin) return errorResponse('用户不存在', 404);
  if (admin.role !== 'admin') return errorResponse('权限不足', 403);

  const { targetUserId, newId } = body;
  if (!targetUserId || !newId) return errorResponse('请提供用户ID和新ID');
  if (!/^\d+$/.test(newId)) return errorResponse('ID必须为数字');
  if (newId.length < 6) return errorResponse('ID至少6位');

  const existing = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [newId]);
  if (existing.results && existing.results.length > 0) return errorResponse('该ID已被使用');

  const oldUserResult = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const oldUser = oldUserResult.results && oldUserResult.results[0];
  if (!oldUser) return errorResponse('用户不存在', 404);

  try {
    await runDB(env,
      `INSERT INTO users (id, username, password, role, diamond, balance, status, banner, avatar, club_prefix, level, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, oldUser.username, oldUser.password, oldUser.role,
       oldUser.diamond || 0, oldUser.balance || 0, oldUser.status || 'active',
       oldUser.banner || '', oldUser.avatar || '', oldUser.club_prefix || '',
       oldUser.level || 1, oldUser.created_at || new Date().toISOString()]
    );
  } catch (err) {
    return errorResponse('创建新用户失败: ' + err.message, 500);
  }

  const migrateTables = [
    { table: 'orders', cols: ['boss_id', 'handler_id'] },
    { table: 'messages', cols: ['sender_id', 'receiver_id'] },
    { table: 'message_contacts', cols: ['user_id', 'contact_id'] },
    { table: 'posts', cols: ['user_id'] },
    { table: 'post_comments', cols: ['user_id'] },
    { table: 'post_likes', cols: ['user_id'] },
    { table: 'user_avatars', cols: ['user_id'] },
    { table: 'recharge_requests', cols: ['user_id'] },
    { table: 'withdraw_requests', cols: ['user_id'] },
  ];
  for (const item of migrateTables) {
    for (const col of item.cols) {
      try {
        await runDB(env, `UPDATE ${item.table} SET ${col} = ? WHERE ${col} = ?`, [newId, targetUserId]);
      } catch (e) { console.warn('迁移失败:', item.table, col, e.message); }
    }
  }

  try {
    await runDB(env, 'DELETE FROM users WHERE id = ?', [targetUserId]);
  } catch (err) {
    return errorResponse('删除旧用户失败: ' + err.message, 500);
  }

  return jsonResponse({ success: true, message: '用户ID已修改，请重新登录' });
}

// ============================================================
//  头像 / 改名 / 背景墙
// ============================================================
async function handleUploadAvatar(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { avatar_url } = body;
  if (!avatar_url) return errorResponse('请提供头像URL');
  await runDB(env,
    'INSERT INTO user_avatars (id, user_id, avatar_url, created_at) VALUES (?, ?, ?, ?)',
    [generateId(), userId, avatar_url, new Date().toISOString()]
  );
  await runDB(env, 'UPDATE users SET avatar = ? WHERE id = ?', [avatar_url, userId]);
  return jsonResponse({ success: true, avatar_url, message: '头像已更新' });
}

async function handleChangeName(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { username } = body;
  if (!username) return errorResponse('请输入新用户名');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ? AND id != ?', [username, userId]);
  if (existing.results && existing.results.length > 0) return errorResponse('用户名已被使用');
  await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [username, userId]);
  return jsonResponse({ success: true, message: '昵称已修改' });
}

async function handleSetBanner(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { banner } = body;
  await runDB(env, 'UPDATE users SET banner = ? WHERE id = ?', [banner || '', userId]);
  return jsonResponse({ success: true, message: '背景墙已更新' });
}

// ============================================================
//  帖子系统
// ============================================================
async function handleCreatePost(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { content, images, category_id } = body;
  if (!content || !content.trim()) return errorResponse('请输入内容');
  const id = generateId();
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  const now = new Date().toISOString();
  try {
    await runDB(env,
      `INSERT INTO posts (id, user_id, content, images, category_id, likes, comments_count, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?, ?)`,
      [id, userId, content.trim(), imagesJson, category_id || null, now, now]
    );
  } catch (err) {
    await runDB(env,
      `INSERT INTO posts (id, user_id, content, images, category_id, likes, comments_count, status, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?)`,
      [id, userId, content.trim(), imagesJson, category_id || null, now]
    );
  }
  return jsonResponse({ success: true, postId: id, message: '帖子发布成功' });
}

async function handleGetPosts(env, url) {
  const userId = url?.searchParams?.get('user_id');
  let sql = `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.status = 'active'
  `;
  const params = [];
  if (userId) { sql += ' AND p.user_id = ?'; params.push(userId); }
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetPostDetail(env, postId) {
  const result = await queryDB(env, `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = ? AND p.status = 'active'
  `, [postId]);
  const post = result.results?.[0] || null;
  if (!post) return errorResponse('帖子不存在', 404);
  const commentsResult = await queryDB(env, `
    SELECT c.*, u.username, u.avatar
    FROM post_comments c
    LEFT JOIN users u ON c.user_id = u.id
    WHERE c.post_id = ?
    ORDER BY c.created_at ASC
  `, [postId]);
  post.comments = commentsResult.results || [];
  return jsonResponse(post);
}

async function handleLikePost(env, authHeader, postId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const check = await queryDB(env, 'SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
  if (check.results && check.results.length > 0) {
    await runDB(env, 'DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    await runDB(env, 'UPDATE posts SET likes = likes - 1 WHERE id = ?', [postId]);
    return jsonResponse({ success: true, liked: false });
  } else {
    await runDB(env, 'INSERT INTO post_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      [generateId(), postId, userId, new Date().toISOString()]);
    await runDB(env, 'UPDATE posts SET likes = likes + 1 WHERE id = ?', [postId]);
    return jsonResponse({ success: true, liked: true });
  }
}

async function handleCommentPost(env, authHeader, postId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { content } = body;
  if (!content || !content.trim()) return errorResponse('请输入评论内容');
  const id = generateId();
  await runDB(env,
    'INSERT INTO post_comments (id, post_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, postId, userId, content.trim(), new Date().toISOString()]
  );
  await runDB(env, 'UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?', [postId]);
  return jsonResponse({ success: true, commentId: id, message: '评论成功' });
}

async function handleDeletePost(env, authHeader, postId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM posts WHERE id = ?', [postId]);
  const post = result.results?.[0] || null;
  if (!post) return errorResponse('帖子不存在', 404);
  if (post.user_id !== userId) {
    const user = await getUserById(env, userId);
    if (user.role !== 'admin') return errorResponse('无权删除', 403);
  }
  await runDB(env, 'UPDATE posts SET status = "deleted" WHERE id = ?', [postId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  帖子分类
// ============================================================
async function handleGetPostCategories(env) {
  const result = await queryDB(env, 'SELECT * FROM post_categories ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleCreatePostCategory(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { name, icon, sort_order } = body;
  if (!name) return errorResponse('请输入分类名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO post_categories (id, name, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, name, icon || '📝', sort_order || 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '分类已创建' });
}

async function handleDeletePostCategory(env, authHeader, catId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM post_categories WHERE id = ?', [catId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  商品分类
// ============================================================
async function handleGetCategories(env) {
  const result = await queryDB(env, 'SELECT * FROM categories ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminCreateCategory(env, body) {
  const { name, image, sort_order, parent_id } = body;
  if (!name) return errorResponse('请填写分类名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO categories (id, name, image, sort_order, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, image || '', sort_order || 0, parent_id || null, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '分类创建成功' });
}

async function handleAdminUpdateCategory(env, categoryId, body) {
  const { name, image, sort_order, parent_id } = body;
  let sql = 'UPDATE categories SET ';
  const params = [];
  const updates = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (image !== undefined) { updates.push('image = ?'); params.push(image || ''); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order || 0); }
  if (parent_id !== undefined) { updates.push('parent_id = ?'); params.push(parent_id || null); }
  if (updates.length === 0) return errorResponse('没有要更新的字段');
  sql += updates.join(', ') + ' WHERE id = ?';
  params.push(categoryId);
  await runDB(env, sql, params);
  return jsonResponse({ success: true, message: '分类已更新' });
}

async function handleAdminDeleteCategory(env, categoryId) {
  const check = await queryDB(env, 'SELECT COUNT(*) as count FROM products WHERE category_id = ?', [categoryId]);
  if (check.results && check.results[0] && check.results[0].count > 0) return errorResponse('该分类下还有商品', 400);
  const childCheck = await queryDB(env, 'SELECT COUNT(*) as count FROM categories WHERE parent_id = ?', [categoryId]);
  if (childCheck.results && childCheck.results[0] && childCheck.results[0].count > 0) return errorResponse('该分类下还有子分类', 400);
  await runDB(env, 'DELETE FROM categories WHERE id = ?', [categoryId]);
  return jsonResponse({ success: true, message: '分类已删除' });
}

// ============================================================
//  商品管理
// ============================================================
async function handleGetProducts(env, url) {
  const category = url?.searchParams?.get('category');
  const shop = url?.searchParams?.get('shop');
  const shopCategory = url?.searchParams?.get('shop_category');
  let sql = `SELECT p.*, c.name as category_name, s.name as shop_name, sc.name as shop_category_name
             FROM products p
             LEFT JOIN categories c ON p.category_id = c.id
             LEFT JOIN shops s ON p.shop_id = s.id
             LEFT JOIN shop_categories sc ON p.shop_category_id = sc.id
             WHERE p.hidden = 0`;
  const params = [];
  if (category) { sql += ' AND p.category_id = ?'; params.push(category); }
  if (shop) { sql += ' AND p.shop_id = ?'; params.push(shop); }
  if (shopCategory) { sql += ' AND p.shop_category_id = ?'; params.push(shopCategory); }
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetProductDetail(env, productId) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name, s.name as shop_name, sc.name as shop_category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     LEFT JOIN shops s ON p.shop_id = s.id
     LEFT JOIN shop_categories sc ON p.shop_category_id = sc.id
     WHERE p.id = ?`,
    [productId]
  );
  const product = (result.results && result.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  let detailImages = [];
  if (product.detail_images) {
    try { detailImages = JSON.parse(product.detail_images); } catch(e) { detailImages = []; }
  }
  if (detailImages.length === 0 && product.image) detailImages = [product.image];
  product.detail_images = detailImages;
  return jsonResponse(product);
}

async function handleAdminGetProducts(env) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name, s.name as shop_name, sc.name as shop_category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     LEFT JOIN shops s ON p.shop_id = s.id
     LEFT JOIN shop_categories sc ON p.shop_category_id = sc.id
     ORDER BY p.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminCreateProduct(env, body) {
  const { game, title, desc, price, quantity, image, category_id, detail_images, detail_desc, shop_id, shop_category_id } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  if (!category_id) return errorResponse('请选择系统分类');
  const id = generateId();
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, detail_images, detail_desc, category_id, shop_id, shop_category_id)
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?)`,
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1,
     image || '', detailImagesJson, detail_desc || '', category_id,
     shop_id || null, shop_category_id || null]
  );
  return jsonResponse({ success: true, id });
}

async function handleAdminUpdateProduct(env, productId, body) {
  const { game, title, desc, price, quantity, image, category_id, detail_images, detail_desc, shop_id, shop_category_id } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  let finalGame = game || '';
  let finalCategoryId = category_id || null;
  if (finalCategoryId) {
    const categoryResult = await queryDB(env, 'SELECT id, name, parent_id FROM categories WHERE id = ?', [finalCategoryId]);
    const category = categoryResult.results && categoryResult.results[0];
    if (!category) return errorResponse('所选分类不存在', 400);
    finalGame = category.name;
  } else {
    return errorResponse('请选择系统分类', 400);
  }
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, category_id = ?, detail_images = ?, detail_desc = ?, shop_id = ?, shop_category_id = ? WHERE id = ?`,
    [finalGame, title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', finalCategoryId, detailImagesJson, detail_desc || '', shop_id || null, shop_category_id || null, productId]
  );
  return jsonResponse({ success: true, message: '商品已更新' });
}

async function handleAdminUnshelf(env, productId) {
  const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!check.results || check.results.length === 0) return errorResponse('商品不存在', 404);
  await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已下架' });
}

async function handleAdminReshelf(env, productId) {
  const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  if (!check.results || check.results.length === 0) return errorResponse('商品不存在', 404);
  await runDB(env, 'UPDATE products SET hidden = 0 WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已重新上架' });
}

async function handleAdminDeleteProduct(env, productId) {
  await runDB(env, 'DELETE FROM products WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  店铺管理
// ============================================================
async function handleGetShops(env, url) {
  const category = url?.searchParams?.get('category');
  let sql = 'SELECT * FROM shops ORDER BY sort_order ASC, is_self DESC, is_recommend DESC, created_at DESC';
  const params = [];
  if (category) {
    sql = 'SELECT * FROM shops WHERE category_id = ? ORDER BY sort_order ASC, is_self DESC, is_recommend DESC, created_at DESC';
    params.push(category);
  }
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleUpdateShopSort(env, authHeader, shopId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const { sort_order } = body;
  await runDB(env, 'UPDATE shops SET sort_order = ? WHERE id = ?', [parseInt(sort_order) || 0, shopId]);
  return jsonResponse({ success: true, message: '排序已更新' });
}

async function handleCreateShop(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') return errorResponse('只有管理员可创建店铺', 403);
  const { name, description, logo, banner, category_id, is_self, is_recommend } = body;
  if (!name) return errorResponse('请输入店铺名称');
  if (!category_id) return errorResponse('请选择主分类');
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM shops');
  const count = countResult.results?.[0]?.count || 0;
  const shopId = 'a' + String(100000 + count + 1);
  await runDB(env,
    `INSERT INTO shops (id, owner_id, name, description, logo, banner, category_id, status, rating, sales, is_self, is_recommend, follow_count, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '4.9', 0, ?, ?, 0, ?)`,
    [shopId, userId, name, description || '', logo || '', banner || '', category_id, is_self ? 1 : 0, is_recommend ? 1 : 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id: shopId, message: '店铺创建成功' });
}

async function handleUpdateShop(env, authHeader, shopId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') return errorResponse('只有管理员可编辑店铺', 403);
  const { name, description, logo, banner, category_id, is_self, is_recommend } = body;
  if (!name) return errorResponse('请输入店铺名称');
  await runDB(env,
    `UPDATE shops SET name = ?, description = ?, logo = ?, banner = ?, category_id = ?, is_self = ?, is_recommend = ? WHERE id = ?`,
    [name, description || '', logo || '', banner || '', category_id || null, is_self ? 1 : 0, is_recommend ? 1 : 0, shopId]
  );
  return jsonResponse({ success: true, message: '店铺已更新' });
}

async function handleToggleShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) return errorResponse('店铺不存在', 404);
  const shop = result.results[0];
  const newStatus = shop.status === 'active' ? 'inactive' : 'active';
  await runDB(env, 'UPDATE shops SET status = ? WHERE id = ?', [newStatus, shopId]);
  return jsonResponse({ success: true, message: `店铺已${newStatus === 'active' ? '开启' : '关闭'}` });
}

async function handleDeleteShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const check = await queryDB(env, 'SELECT COUNT(*) as count FROM products WHERE shop_id = ?', [shopId]);
  if (check.results && check.results[0] && check.results[0].count > 0) return errorResponse('该店铺下还有商品', 400);
  await runDB(env, 'DELETE FROM shops WHERE id = ?', [shopId]);
  return jsonResponse({ success: true, message: '店铺已删除' });
}

async function handleGetShopDetail(env, shopId) {
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) return errorResponse('店铺不存在', 404);
  const shop = result.results[0];
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM products WHERE shop_id = ? AND hidden = 0', [shopId]);
  shop.productCount = countResult.results?.[0]?.count || 0;
  return jsonResponse(shop);
}

async function handleGetShopProducts(env, shopId) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name, sc.name as shop_category_name
     FROM products p
     LEFT JOIN categories c ON p.category_id = c.id
     LEFT JOIN shop_categories sc ON p.shop_category_id = sc.id
     WHERE p.shop_id = ? AND p.hidden = 0
     ORDER BY p.created_at DESC`,
    [shopId]
  );
  return jsonResponse(result.results || []);
}

async function handleGetShopCategories(env, shopId) {
  const result = await queryDB(env,
    'SELECT * FROM shop_categories WHERE shop_id = ? ORDER BY sort_order ASC, created_at DESC',
    [shopId]
  );
  return jsonResponse(result.results || []);
}

async function handleCreateShopCategory(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const { shop_id, name, image_url } = body;
  if (!shop_id) return errorResponse('请选择店铺');
  if (!name) return errorResponse('请输入分类名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO shop_categories (id, shop_id, name, image_url, sort_order, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [id, shop_id, name, image_url || '', new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '店铺分类创建成功' });
}

async function handleDeleteShopCategory(env, authHeader, categoryId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM shop_categories WHERE id = ?', [categoryId]);
  return jsonResponse({ success: true, message: '店铺分类已删除' });
}

// ============================================================
//  关注店铺
// ============================================================
async function handleFollowShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const check = await queryDB(env, 'SELECT * FROM shop_follows WHERE user_id = ? AND shop_id = ?', [userId, shopId]);
  if (check.results && check.results.length > 0) {
    await runDB(env, 'DELETE FROM shop_follows WHERE user_id = ? AND shop_id = ?', [userId, shopId]);
    await runDB(env, 'UPDATE shops SET follow_count = follow_count - 1 WHERE id = ?', [shopId]);
    return jsonResponse({ success: true, message: '已取消关注', followed: false });
  } else {
    await runDB(env, 'INSERT INTO shop_follows (id, user_id, shop_id, created_at) VALUES (?, ?, ?, ?)',
      [generateId(), userId, shopId, new Date().toISOString()]);
    await runDB(env, 'UPDATE shops SET follow_count = follow_count + 1 WHERE id = ?', [shopId]);
    return jsonResponse({ success: true, message: '关注成功', followed: true });
  }
}

async function handleGetFollowStatus(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return jsonResponse({ followed: false });
  const check = await queryDB(env, 'SELECT * FROM shop_follows WHERE user_id = ? AND shop_id = ?', [userId, shopId]);
  return jsonResponse({ followed: (check.results && check.results.length > 0) });
}

// ============================================================
//  订单系统
// ============================================================
async function handleBuyProduct(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { productId, assignedHandlerId } = body;
  if (!productId) return errorResponse('请选择商品');
  const prodResult = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  const product = (prodResult.results && prodResult.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  const sold = product.sold || 0;
  if (product.quantity <= sold) return errorResponse('库存不足');
  const diamondCost = product.price * 10;
  if (user.diamond < diamondCost) return errorResponse('红钻不足，请先充值');
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);
  const orderId = generateId();
  await runDB(env,
    `INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages, handler_id)
     VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
    [orderId, productId, userId, product.price, product.game, product.title, product.desc || '',
     JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date().toISOString() }]),
     assignedHandlerId || null]
  );
  await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
  return jsonResponse({ orderId, message: '购买成功' });
}

async function handleGetMyOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  let sql = '';
  if (user.role === 'boss' || user.role === 'service' || user.role === 'admin' || user.role === 'dispatcher') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else if (user.role === 'handler') {
    const pendingResult = await queryDB(env, 'SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC');
    const myResult = await queryDB(env, 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC', [userId]);
    const all = [...(pendingResult.results || []), ...(myResult.results || [])];
    const seen = new Set();
    return jsonResponse(all.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; }));
  } else {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, sql, [userId]);
  return jsonResponse(result.results || []);
}

async function handleGetOrderDetail(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('无权查看', 403);
  }
  return jsonResponse(order);
}

async function handleTakeOrder(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可接单');
  if (user.status !== 'active') return errorResponse('账号未激活');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status !== 'pending') return errorResponse('订单不可接');
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [userId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '接单成功' });
}

async function handleSubmitComplete(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可操作');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.handler_id !== userId) return errorResponse('不是你的订单', 403);
  if (order.status !== 'ongoing') return errorResponse('只有进行中可提交');
  await runDB(env, 'UPDATE orders SET status = "review" WHERE id = ?', [orderId]);
  return jsonResponse({ message: '已提交验收' });
}

async function handleBossConfirm(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service' && user.role !== 'admin') {
    return errorResponse('只有老板、客服或管理员可操作', 403);
  }
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('不是你的订单', 403);
  }
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成' });
}

async function handleRefundRequest(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service' && user.role !== 'admin') {
    return errorResponse('只有老板、客服或管理员可发起退款', 403);
  }
  const { reason } = body;
  if (!reason) return errorResponse('请填写退款原因');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status === 'completed') return errorResponse('已完成订单不可退款');
  if (order.status === 'refunded' || order.status === 'refund_pending') return errorResponse('已处理退款');
  await runDB(env, 'UPDATE orders SET status = "refund_pending", refund_reason = ? WHERE id = ?', [reason, orderId]);
  return jsonResponse({ success: true, message: '退款申请已提交' });
}

// ============================================================
//  派单员
// ============================================================
async function handleDispatcherPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') return errorResponse('只有派单员或管理员可发布订单', 403);
  const { game, title, desc, price, assignedHandlerId } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  if (price < 1) return errorResponse('价格至少为1红钻');
  if (user.diamond < price) return errorResponse(`红钻不足，需要 ${price} 红钻`, 400);
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [price, userId]);
  const orderId = generateId();
  let status = 'pending';
  let handlerId = assignedHandlerId || null;
  let messages = JSON.stringify([{ sender: 'system', content: `📋 派单员发布订单：${title}`, time: new Date().toISOString() }]);
  if (handlerId) {
    const handlerCheck = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler" AND status = "active"', [handlerId]);
    if (handlerCheck.results && handlerCheck.results.length > 0) {
      status = 'ongoing';
      messages = JSON.stringify([{ sender: 'system', content: `📋 派单员发布订单：${title}，已指派打手`, time: new Date().toISOString() }]);
    } else {
      handlerId = null;
    }
  }
  await runDB(env,
    `INSERT INTO orders (id, boss_id, handler_id, status, price, game, title, description, messages, start_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, userId, handlerId, status, parseFloat(price), game || '暗区突围', title, desc || '', messages, handlerId ? new Date().toISOString() : null]
  );
  return jsonResponse({ success: true, orderId, message: `订单发布成功` });
}

async function handleDispatcherStats(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'dispatcher' && user.role !== 'admin')) return errorResponse('无权查看', 403);
  const result = await queryDB(env,
    `SELECT COUNT(*) as total,
      SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) as pending,
      SUM(CASE WHEN status = 'ongoing' THEN 1 ELSE 0 END) as ongoing,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed
     FROM orders WHERE boss_id = ?`,
    [userId]
  );
  return jsonResponse((result.results && result.results[0]) || { total: 0, pending: 0, ongoing: 0, completed: 0 });
}

async function handleDispatcherOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'dispatcher' && user.role !== 'admin')) return errorResponse('无权查看', 403);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC', [userId]);
  return jsonResponse(result.results || []);
}

async function handleDispatcherConfirmComplete(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'dispatcher' && user.role !== 'admin')) return errorResponse('权限不足', 403);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'admin') return errorResponse('不是你的订单', 403);
  if (order.status !== 'ongoing' && order.status !== 'pending') return errorResponse('订单状态不可确认', 400);
  const diamondCost = order.price;
  if (user.diamond < diamondCost) return errorResponse(`红钻不足`);
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);
  const handlerEarning = Math.floor(order.price * 0.8);
  if (order.handler_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [handlerEarning, order.handler_id]);
  }
  await runDB(env,
    'UPDATE orders SET status = "completed", end_time = ?, settled = 1, settled_amount = ? WHERE id = ?',
    [new Date().toISOString(), handlerEarning, orderId]
  );
  return jsonResponse({ success: true, message: `验收完成` });
}

async function handleSendChat(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { content } = body;
  if (!content) return errorResponse('内容不能为空');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('无权操作', 403);
  }
  const sender = user.role === 'boss' ? 'boss' : user.role === 'handler' ? 'handler' : user.role === 'dispatcher' ? 'dispatcher' : user.role === 'service' ? 'service' : 'admin';
  let messages = [];
  try { messages = JSON.parse(order.messages || '[]'); } catch (e) { messages = []; }
  messages.push({ sender, content, time: new Date().toISOString() });
  await runDB(env, 'UPDATE orders SET messages = ? WHERE id = ?', [JSON.stringify(messages), orderId]);
  return jsonResponse({ message: '发送成功' });
}

// ============================================================
//  充值
// ============================================================
async function handleCustomRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效金额');
  if (amount > 999999) return errorResponse('金额过大');
  const diamond = Math.floor(amount * 10);
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharge_requests (id, user_id, amount, diamond, status, created_at) VALUES (?, ?, ?, ?, "pending", ?)',
    [id, userId, amount, diamond, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: `充值申请已提交，可获得 ${diamond} 红钻` });
}

async function handleGetMyRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return jsonResponse(result.results || []);
}

// ============================================================
//  充值图片
// ============================================================
async function handleGetRechargeImages(env) {
  const result = await queryDB(env, 'SELECT * FROM recharge_images ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAddRechargeImage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { image_url, sort_order } = body;
  if (!image_url) return errorResponse('请输入图片URL');
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharge_images (id, image_url, sort_order, created_at) VALUES (?, ?, ?, ?)',
    [id, image_url, sort_order || 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '图片已添加' });
}

async function handleDeleteRechargeImage(env, authHeader, imageId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM recharge_images WHERE id = ?', [imageId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  客服
// ============================================================
async function handleGetPendingRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    `SELECT r.*, u.username
     FROM recharge_requests r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.status = 'pending'
     ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleProcessRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const { requestId, action, rejectReason } = body;
  if (!requestId || !action) return errorResponse('参数不完整');
  const req = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [requestId]);
  if (!req.results || req.results.length === 0) return errorResponse('申请不存在');
  const request = req.results[0];
  if (request.status !== 'pending') return errorResponse('已处理');
  if (action === 'approve') {
    if (user.diamond < request.diamond) return errorResponse(`红钻不足`);
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [request.diamond, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.diamond, request.user_id]);
    await runDB(env, 'UPDATE recharge_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?',
      [userId, new Date().toISOString(), requestId]);
    return jsonResponse({ success: true, message: `充值已通过` });
  } else {
    await runDB(env, 'UPDATE recharge_requests SET status = "rejected", handler_id = ?, reject_reason = ?, handled_at = ? WHERE id = ?',
      [userId, rejectReason || '无原因', new Date().toISOString(), requestId]);
    return jsonResponse({ success: true, message: '已拒绝' });
  }
}

async function handleGetUsersForService(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    'SELECT id, username, role FROM users WHERE role NOT IN ("admin", "service", "handler")'
  );
  return jsonResponse(result.results || []);
}

async function handleServiceGift(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount || amount < 1) return errorResponse('请填写完整信息');
  if (user.diamond < amount) return errorResponse(`红钻不足，需要 ${amount} 红钻`);
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: `已赠送 ${amount} 红钻` });
}

// ============================================================
//  消息
// ============================================================
async function handleSendMessage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { receiverId, content } = body;
  if (!receiverId || !content || !content.trim()) return errorResponse('请完整填写');
  const receiver = await getUserById(env, receiverId);
  if (!receiver) return errorResponse('接收者不存在', 404);
  if (userId === receiverId) return errorResponse('不能给自己发消息', 403);
  const id = generateId();
  await runDB(env,
    'INSERT INTO messages (id, sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [id, userId, receiverId, content.trim(), new Date().toISOString()]
  );
  const c1 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [userId, receiverId]);
  if (!c1.results || c1.results.length === 0) {
    await runDB(env, 'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 0)',
      [generateId(), userId, receiverId, content.trim(), new Date().toISOString()]);
  } else {
    await runDB(env, 'UPDATE message_contacts SET last_message = ?, last_time = ? WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), userId, receiverId]);
  }
  const c2 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [receiverId, userId]);
  if (!c2.results || c2.results.length === 0) {
    await runDB(env, 'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 1)',
      [generateId(), receiverId, userId, content.trim(), new Date().toISOString()]);
  } else {
    await runDB(env, 'UPDATE message_contacts SET last_message = ?, last_time = ?, unread_count = unread_count + 1 WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), receiverId, userId]);
  }
  return jsonResponse({ success: true, message: '发送成功' });
}

async function handleGetContacts(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const sql = `
    WITH all_contacts AS (
      SELECT DISTINCT sender_id as contact_id FROM messages WHERE receiver_id = ?
      UNION
      SELECT DISTINCT receiver_id as contact_id FROM messages WHERE sender_id = ?
    )
    SELECT u.id, u.username, u.role, u.avatar, mc.last_message, mc.last_time, mc.unread_count
    FROM all_contacts ac
    JOIN users u ON u.id = ac.contact_id
    LEFT JOIN message_contacts mc ON mc.user_id = ? AND mc.contact_id = ac.contact_id
    WHERE u.id != ?
    ORDER BY COALESCE(mc.last_time, '1970-01-01') DESC
  `;
  const result = await queryDB(env, sql, [userId, userId, userId, userId]);
  return jsonResponse(result.results || []);
}

async function handleGetMessages(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { contactId } = body;
  if (!contactId) return errorResponse('请选择联系人');
  const contact = await getUserById(env, contactId);
  if (!contact) return errorResponse('联系人不存在', 404);
  const result = await queryDB(env,
    `SELECT m.*, u.username as sender_name, u.avatar as sender_avatar
     FROM messages m
     LEFT JOIN users u ON m.sender_id = u.id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.created_at ASC`,
    [userId, contactId, contactId, userId]
  );
  await runDB(env, 'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?', [contactId, userId]);
  await runDB(env, 'UPDATE message_contacts SET unread_count = 0 WHERE user_id = ? AND contact_id = ?', [userId, contactId]);
  return jsonResponse(result.results || []);
}

async function handleGetUnreadCount(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT SUM(unread_count) as total FROM message_contacts WHERE user_id = ?', [userId]);
  const total = (result.results && result.results[0] && result.results[0].total) || 0;
  return jsonResponse({ unread: total });
}

async function handleGetSupportContacts(env) {
  const result = await queryDB(env,
    'SELECT id, username, role FROM users WHERE role IN ("admin", "service") AND status = "active"'
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  提现
// ============================================================
async function handleRequestWithdraw(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可申请提现', 403);
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效数量');
  const available = Math.max(0, (user.diamond || 0) - 100);
  if (amount > available) return errorResponse(`可提现红钻不足，可用：${available}`, 400);
  const id = generateId();
  await runDB(env, 'INSERT INTO withdraw_requests (id, user_id, amount, status, created_at) VALUES (?, ?, ?, "pending", ?)',
    [id, userId, amount, new Date().toISOString()]);
  return jsonResponse({ success: true, message: '提现申请已提交' });
}

async function handleAdminGetWithdrawals(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    `SELECT w.*, u.username FROM withdraw_requests w
     LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminApproveWithdraw(env, authHeader, withdrawId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const result = await queryDB(env, 'SELECT * FROM withdraw_requests WHERE id = ?', [withdrawId]);
  if (!result.results || result.results.length === 0) return errorResponse('提现申请不存在', 404);
  const withdraw = result.results[0];
  if (withdraw.status !== 'pending') return errorResponse('已处理', 400);
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [withdraw.amount, withdraw.user_id]);
  await runDB(env, 'UPDATE withdraw_requests SET status = "approved", handled_at = ? WHERE id = ?',
    [new Date().toISOString(), withdrawId]);
  return jsonResponse({ success: true, message: `提现已通过` });
}

async function handleAdminRejectWithdraw(env, authHeader, withdrawId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { reason } = body;
  const result = await queryDB(env, 'SELECT * FROM withdraw_requests WHERE id = ?', [withdrawId]);
  if (!result.results || result.results.length === 0) return errorResponse('提现申请不存在', 404);
  const withdraw = result.results[0];
  if (withdraw.status !== 'pending') return errorResponse('已处理', 400);
  await runDB(env, 'UPDATE withdraw_requests SET status = "rejected", reject_reason = ?, handled_at = ? WHERE id = ?',
    [reason || '无原因', new Date().toISOString(), withdrawId]);
  return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleAdminDeleteWithdraw(env, authHeader, withdrawId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM withdraw_requests WHERE id = ?', [withdrawId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  广告
// ============================================================
async function handleGetBanners(env) {
  const result = await queryDB(env, 'SELECT * FROM banners ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminCreateBanner(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { image_url, link, sort_order } = body;
  if (!image_url) return errorResponse('请输入图片URL');
  const id = generateId();
  await runDB(env, 'INSERT INTO banners (id, image_url, link, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, image_url, link || '', sort_order || 0, new Date().toISOString()]);
  return jsonResponse({ success: true, id, message: '广告添加成功' });
}

async function handleAdminDeleteBanner(env, authHeader, bannerId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM banners WHERE id = ?', [bannerId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  图标
// ============================================================
async function handleGetIcons(env) {
  const result = await queryDB(env, 'SELECT * FROM custom_icons');
  return jsonResponse(result.results || []);
}

async function handleAdminSetIcon(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { key, image_url } = body;
  if (!key) return errorResponse('请指定图标key');
  if (!image_url) return errorResponse('请输入图片URL');
  const existing = await queryDB(env, 'SELECT * FROM custom_icons WHERE key = ?', [key]);
  if (existing.results && existing.results.length > 0) {
    await runDB(env, 'UPDATE custom_icons SET image_url = ? WHERE key = ?', [image_url, key]);
  } else {
    await runDB(env,
      'INSERT INTO custom_icons (id, key, image_url, created_at) VALUES (?, ?, ?, ?)',
      [generateId(), key, image_url, new Date().toISOString()]
    );
  }
  return jsonResponse({ success: true, message: '图标已更新' });
}

async function handleAdminDeleteIcon(env, authHeader, key) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM custom_icons WHERE key = ?', [key]);
  return jsonResponse({ success: true, message: '图标已删除' });
}

// ============================================================
//  公告
// ============================================================
async function handleGetAnnounce(env) {
  const result = await queryDB(env, 'SELECT * FROM announces ORDER BY updated_at DESC LIMIT 1');
  const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
  if (typeof data.images === 'string') {
    try { data.images = JSON.parse(data.images); } catch(e) { data.images = []; }
  }
  return jsonResponse(data);
}

async function handleAdminUpdateAnnounce(env, body) {
  const { content, images } = body;
  await runDB(env, 'DELETE FROM announces');
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  await runDB(env, 'INSERT INTO announces (id, content, images, updated_at) VALUES (?, ?, ?, ?)',
    [generateId(), content || '欢迎使用 QW电竞护航平台！', imagesJson, new Date().toISOString()]);
  return jsonResponse({ success: true, message: '公告已更新' });
}

// ============================================================
//  邮件
// ============================================================
async function handleGetMails(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM mails WHERE user_id = ? ORDER BY created_at DESC', [userId]);
  return jsonResponse(result.results || []);
}

async function handleClaimMail(env, authHeader, mailId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM mails WHERE id = ?', [mailId]);
  const mail = (result.results && result.results[0]) || null;
  if (!mail) return errorResponse('邮件不存在', 404);
  if (mail.user_id !== userId) return errorResponse('无权操作', 403);
  if (mail.status === 'read') return errorResponse('已领取');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [mail.diamond || 0, userId]);
  await runDB(env, 'UPDATE mails SET status = "read", claim_time = ? WHERE id = ?', [new Date().toISOString(), mailId]);
  return jsonResponse({ message: '领取成功' });
}

// ============================================================
//  管理员订单
// ============================================================
async function handleAdminGetOrders(env) {
  const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminAssignHandler(env, orderId, body) {
  const { handlerId } = body;
  if (!handlerId) return errorResponse('请选择打手');
  const userResult = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler"', [handlerId]);
  if (!userResult.results || userResult.results.length === 0) return errorResponse('打手不存在');
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?',
    [handlerId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '指派成功' });
}

async function handleAdminForceComplete(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
    [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '强制完成成功' });
}

async function handleAdminConfirm(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
    [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '验收通过' });
}

async function handleAdminReject(env, orderId, body) {
  const { reason } = body;
  await runDB(env, 'UPDATE orders SET status = "rejected", refund_reason = ? WHERE id = ?',
    [reason || '无原因', orderId]);
  return jsonResponse({ message: '已驳回' });
}

async function handleAdminCancelOrder(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
  if (order && order.boss_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price, order.boss_id]);
  }
  return jsonResponse({ message: '已取消' });
}

async function handleAdminSettle(env, orderId, body) {
  const { earning } = body;
  const amount = parseFloat(earning);
  if (isNaN(amount) || amount < 0) return errorResponse('金额无效');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.settled) return errorResponse('已结算');
  if (order.status !== 'completed') return errorResponse('只有已完成订单可结算');
  if (order.handler_id) {
    const diamondAmount = amount * 10;
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [diamondAmount, order.handler_id]);
  }
  await runDB(env, 'UPDATE orders SET settled = 1, settled_amount = ? WHERE id = ?', [amount, orderId]);
  return jsonResponse({ success: true, message: `结算成功 ${amount} 红钻` });
}

async function handleAdminDirectPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { game, title, desc, price } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const orderId = generateId();
  await runDB(env,
    'INSERT INTO orders (id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, "pending", ?, ?, ?, ?, ?)',
    [orderId, userId, parseFloat(price), game || '暗区突围', title, desc || '',
     JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date().toISOString() }])]
  );
  return jsonResponse({ success: true, orderId });
}

async function handleAdminDeleteOrder(env, orderId) {
  await runDB(env, 'DELETE FROM orders WHERE id = ?', [orderId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  管理员充值
// ============================================================
async function handleAdminGetRecharges(env) {
  const result = await queryDB(env,
    `SELECT r.*, u.username FROM recharge_requests r
     LEFT JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminApproveRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "approved", handled_at = ? WHERE id = ?',
    [new Date().toISOString(), rechargeId]);
  if (recharge.user_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
  }
  return jsonResponse({ success: true, message: '审核通过' });
}

async function handleAdminRejectRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "rejected", handled_at = ? WHERE id = ?',
    [new Date().toISOString(), rechargeId]);
  return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleAdminDeleteRecharge(env, rechargeId) {
  await runDB(env, 'DELETE FROM recharge_requests WHERE id = ?', [rechargeId]);
  return jsonResponse({ success: true, message: '已删除' });
}

async function handleAdminGiftDiamond(env, body) {
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount) return errorResponse('请填写完整信息');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: '赠送成功' });
}

// ============================================================
//  打手列表
// ============================================================
async function handleGetHandlers(env) {
  const result = await queryDB(env, 'SELECT id, username FROM users WHERE role = "handler" AND status = "active"');
  return jsonResponse(result.results || []);
}

// ============================================================
//  健康检查
// ============================================================
async function handleHealthCheck(env) {
  return jsonResponse({ status: 'ok', time: new Date().toISOString() });
}

// ============================================================
//  入口路由
// ============================================================
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;
  const env = context.env;

  let body = {};
  try {
    const text = await request.text();
    body = text ? JSON.parse(text) : {};
  } catch (e) {}

  if (method === 'OPTIONS') {
    return new Response(null, {
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      }
    });
  }

  try {
    const authHeader = request.headers.get('Authorization');

    // ========== 公开接口 ==========
    if (path === '/api/health' && method === 'GET') return await handleHealthCheck(env);
    if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
    if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(env, url);
    if (path === '/api/categories' && method === 'GET') return await handleGetCategories(env);
    if (path === '/api/post-categories' && method === 'GET') return await handleGetPostCategories(env);
    if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(env);
    if (path === '/api/handlers' && method === 'GET') return await handleGetHandlers(env);
    if (path === '/api/support-contacts' && method === 'GET') return await handleGetSupportContacts(env);
    if (path === '/api/shops' && method === 'GET') return await handleGetShops(env, url);
    if (path === '/api/banners' && method === 'GET') return await handleGetBanners(env);
    if (path === '/api/icons' && method === 'GET') return await handleGetIcons(env);
    if (path === '/api/recharge-images' && method === 'GET') return await handleGetRechargeImages(env);
    if (path === '/api/posts' && method === 'GET') return await handleGetPosts(env, url);

    // 公开用户信息
    if (path.startsWith('/api/users/') && method === 'GET') {
      const userId = path.replace('/api/users/', '');
      return await handleGetUserPublic(env, userId);
    }

    if (path.startsWith('/api/posts/') && method === 'GET') {
      return await handleGetPostDetail(env, path.replace('/api/posts/', ''));
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/products') && method === 'GET') {
      return await handleGetShopProducts(env, path.replace('/api/shops/', '').replace('/products', ''));
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/categories') && method === 'GET') {
      return await handleGetShopCategories(env, path.replace('/api/shops/', '').replace('/categories', ''));
    }
    if (path.startsWith('/api/shops/') && method === 'GET' && !path.endsWith('/products') && !path.endsWith('/categories') && !path.endsWith('/follow') && !path.endsWith('/follow-status')) {
      return await handleGetShopDetail(env, path.replace('/api/shops/', ''));
    }
    if (path.startsWith('/api/products/') && method === 'GET') {
      return await handleGetProductDetail(env, path.replace('/api/products/', ''));
    }

    // ========== 需登录 ==========
    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/user/avatar' && method === 'POST') return await handleUploadAvatar(env, authHeader, body);
    if (path === '/api/user/name' && method === 'PUT') return await handleChangeName(env, authHeader, body);
    if (path === '/api/user/banner' && method === 'PUT') return await handleSetBanner(env, authHeader, body);
    if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(env, authHeader);
    if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(env, authHeader, body);
    if (path === '/api/mails' && method === 'GET') return await handleGetMails(env, authHeader);
    if (path === '/api/dispatcher/stats' && method === 'GET') return await handleDispatcherStats(env, authHeader);
    if (path === '/api/dispatcher/orders' && method === 'GET') return await handleDispatcherOrders(env, authHeader);
    if (path === '/api/dispatcher/publish' && method === 'POST') return await handleDispatcherPublish(env, authHeader, body);
    if (path === '/api/withdraw/request' && method === 'POST') return await handleRequestWithdraw(env, authHeader, body);
    if (path === '/api/recharge/custom' && method === 'POST') return await handleCustomRecharge(env, authHeader, body);
    if (path === '/api/recharge/my' && method === 'GET') return await handleGetMyRecharges(env, authHeader);
    if (path === '/api/posts' && method === 'POST') return await handleCreatePost(env, authHeader, body);
    if (path === '/api/messages/send' && method === 'POST') return await handleSendMessage(env, authHeader, body);
    if (path === '/api/messages/contacts' && method === 'GET') return await handleGetContacts(env, authHeader);
    if (path === '/api/messages/history' && method === 'POST') return await handleGetMessages(env, authHeader, body);
    if (path === '/api/messages/unread' && method === 'GET') return await handleGetUnreadCount(env, authHeader);

    // ========== 客服 ==========
    if (path === '/api/service/recharges' && method === 'GET') return await handleGetPendingRecharges(env, authHeader);
    if (path === '/api/service/process' && method === 'POST') return await handleProcessRecharge(env, authHeader, body);
    if (path === '/api/service/users' && method === 'GET') return await handleGetUsersForService(env, authHeader);
    if (path === '/api/service/gift' && method === 'POST') return await handleServiceGift(env, authHeader, body);

    // ========== 关注店铺 ==========
    if (path.startsWith('/api/shops/') && path.endsWith('/follow') && method === 'POST') {
      return await handleFollowShop(env, authHeader, path.replace('/api/shops/', '').replace('/follow', ''));
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/follow-status') && method === 'GET') {
      return await handleGetFollowStatus(env, authHeader, path.replace('/api/shops/', '').replace('/follow-status', ''));
    }

    // ========== 订单带参数 ==========
    if (path.startsWith('/api/orders/')) {
      const orderId = path.replace('/api/orders/', '');
      if (method === 'GET') return await handleGetOrderDetail(env, authHeader, orderId);
      if (orderId.endsWith('/take')) return await handleTakeOrder(env, authHeader, orderId.replace('/take', ''));
      if (orderId.endsWith('/submit-complete')) return await handleSubmitComplete(env, authHeader, orderId.replace('/submit-complete', ''));
      if (orderId.endsWith('/boss-confirm')) return await handleBossConfirm(env, authHeader, orderId.replace('/boss-confirm', ''));
      if (orderId.endsWith('/refund-request')) return await handleRefundRequest(env, authHeader, orderId.replace('/refund-request', ''), body);
      if (orderId.endsWith('/chat') && method === 'POST') return await handleSendChat(env, authHeader, orderId.replace('/chat', ''), body);
      if (orderId.endsWith('/dispatcher-confirm') && method === 'PUT') return await handleDispatcherConfirmComplete(env, authHeader, orderId.replace('/dispatcher-confirm', ''));
      if (orderId.endsWith('/cancel') && method === 'PUT') return await handleAdminCancelOrder(env, orderId.replace('/cancel', ''));
    }

    // ========== 帖子带参数 ==========
    if (path.startsWith('/api/posts/')) {
      const postId = path.replace('/api/posts/', '');
      if (postId.endsWith('/like') && method === 'POST') return await handleLikePost(env, authHeader, postId.replace('/like', ''));
      if (postId.endsWith('/comment') && method === 'POST') return await handleCommentPost(env, authHeader, postId.replace('/comment', ''), body);
      if (method === 'DELETE') return await handleDeletePost(env, authHeader, postId);
    }

    // ========== 邮件领取 ==========
    if (path.startsWith('/api/mails/') && path.endsWith('/claim') && method === 'PUT') {
      return await handleClaimMail(env, authHeader, path.replace('/api/mails/', '').replace('/claim', ''));
    }

    // ========== 管理员 ==========
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        // 店铺
        if (path === '/api/shops' && method === 'POST') return await handleCreateShop(env, authHeader, body);
        if (path.startsWith('/api/shops/')) {
          const shopId = path.replace('/api/shops/', '');
          if (shopId.endsWith('/toggle') && method === 'PUT') return await handleToggleShop(env, authHeader, shopId.replace('/toggle', ''));
          if (shopId.endsWith('/sort') && method === 'PUT') return await handleUpdateShopSort(env, authHeader, shopId.replace('/sort', ''), body);
          if (method === 'PUT') return await handleUpdateShop(env, authHeader, shopId, body);
          if (method === 'DELETE') return await handleDeleteShop(env, authHeader, shopId);
        }
        // 店铺分类
        if (path === '/api/shop-categories' && method === 'POST') return await handleCreateShopCategory(env, authHeader, body);
        if (path.startsWith('/api/shop-categories/') && method === 'DELETE') {
          return await handleDeleteShopCategory(env, authHeader, path.replace('/api/shop-categories/', ''));
        }
        // 用户
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminGetUsers(env);
        if (path === '/api/admin/user-id' && method === 'PUT') return await handleChangeUserId(env, authHeader, body);
        if (path === '/api/admin/gift' && method === 'POST') return await handleAdminGiftDiamond(env, body);
        if (path.startsWith('/api/admin/users/')) {
          const tId = path.replace('/api/admin/users/', '');
          if (tId.endsWith('/ban') && method === 'PUT') return await handleAdminToggleBan(env, tId.replace('/ban', ''));
          if (tId.endsWith('/reset-password') && method === 'PUT') return await handleAdminResetPassword(env, tId.replace('/reset-password', ''));
          if (tId.endsWith('/approve') && method === 'PUT') return await handleApproveHandler(env, tId.replace('/approve', ''));
          if (tId.endsWith('/username') && method === 'PUT') return await handleChangeUsername(env, tId.replace('/username', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteUser(env, tId);
        }
        // 商品
        if (path === '/api/admin/products' && method === 'GET') return await handleAdminGetProducts(env);
        if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(env, body);
        if (path.startsWith('/api/admin/products/')) {
          const pId = path.replace('/api/admin/products/', '');
          if (pId.endsWith('/unshelf') && method === 'PUT') return await handleAdminUnshelf(env, pId.replace('/unshelf', ''));
          if (pId.endsWith('/reshelf') && method === 'PUT') return await handleAdminReshelf(env, pId.replace('/reshelf', ''));
          if (pId.endsWith('/edit') && method === 'PUT') return await handleAdminUpdateProduct(env, pId.replace('/edit', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteProduct(env, pId);
        }
        // 商品分类
        if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
        if (path.startsWith('/api/admin/categories/')) {
          const cId = path.replace('/api/admin/categories/', '');
          if (cId.endsWith('/edit') && method === 'PUT') return await handleAdminUpdateCategory(env, cId.replace('/edit', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteCategory(env, cId);
        }
        // 帖子分类
        if (path === '/api/admin/post-categories' && method === 'POST') return await handleCreatePostCategory(env, authHeader, body);
        if (path.startsWith('/api/admin/post-categories/') && method === 'DELETE') {
          return await handleDeletePostCategory(env, authHeader, path.replace('/api/admin/post-categories/', ''));
        }
        // 充值图片
        if (path === '/api/admin/recharge-images' && method === 'POST') return await handleAddRechargeImage(env, authHeader, body);
        if (path.startsWith('/api/admin/recharge-images/') && method === 'DELETE') {
          return await handleDeleteRechargeImage(env, authHeader, path.replace('/api/admin/recharge-images/', ''));
        }
        // 广告
        if (path === '/api/admin/banners' && method === 'POST') return await handleAdminCreateBanner(env, authHeader, body);
        if (path.startsWith('/api/admin/banners/') && method === 'DELETE') {
          return await handleAdminDeleteBanner(env, authHeader, path.replace('/api/admin/banners/', ''));
        }
        // 图标
        if (path === '/api/admin/icons' && method === 'POST') return await handleAdminSetIcon(env, authHeader, body);
        if (path.startsWith('/api/admin/icons/') && method === 'DELETE') {
          return await handleAdminDeleteIcon(env, authHeader, path.replace('/api/admin/icons/', ''));
        }
        // 提现
        if (path === '/api/admin/withdrawals' && method === 'GET') return await handleAdminGetWithdrawals(env, authHeader);
        if (path.startsWith('/api/admin/withdrawals/')) {
          const wId = path.replace('/api/admin/withdrawals/', '');
          if (wId.endsWith('/approve') && method === 'PUT') return await handleAdminApproveWithdraw(env, authHeader, wId.replace('/approve', ''));
          if (wId.endsWith('/reject') && method === 'PUT') return await handleAdminRejectWithdraw(env, authHeader, wId.replace('/reject', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteWithdraw(env, authHeader, wId);
        }
        // 订单
        if (path === '/api/admin/orders' && method === 'GET') return await handleAdminGetOrders(env);
        if (path === '/api/admin/orders/direct' && method === 'POST') return await handleAdminDirectPublish(env, authHeader, body);
        if (path.startsWith('/api/admin/orders/')) {
          const oId = path.replace('/api/admin/orders/', '');
          if (oId.endsWith('/assign') && method === 'PUT') return await handleAdminAssignHandler(env, oId.replace('/assign', ''), body);
          if (oId.endsWith('/force-complete') && method === 'PUT') return await handleAdminForceComplete(env, oId.replace('/force-complete', ''));
          if (oId.endsWith('/confirm') && method === 'PUT') return await handleAdminConfirm(env, oId.replace('/confirm', ''));
          if (oId.endsWith('/reject') && method === 'PUT') return await handleAdminReject(env, oId.replace('/reject', ''), body);
          if (oId.endsWith('/cancel') && method === 'PUT') return await handleAdminCancelOrder(env, oId.replace('/cancel', ''));
          if (oId.endsWith('/settle') && method === 'PUT') return await handleAdminSettle(env, oId.replace('/settle', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteOrder(env, oId);
        }
        // 充值
        if (path === '/api/admin/recharges' && method === 'GET') return await handleAdminGetRecharges(env);
        if (path.startsWith('/api/admin/recharges/')) {
          const rId = path.replace('/api/admin/recharges/', '');
          if (rId.endsWith('/approve') && method === 'PUT') return await handleAdminApproveRecharge(env, rId.replace('/approve', ''));
          if (rId.endsWith('/reject') && method === 'PUT') return await handleAdminRejectRecharge(env, rId.replace('/reject', ''));
          if (method === 'DELETE') return await handleAdminDeleteRecharge(env, rId);
        }
        // 公告
        if (path === '/api/admin/announce' && method === 'PUT') return await handleAdminUpdateAnnounce(env, body);
      }
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}