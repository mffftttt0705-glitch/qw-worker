// ============================================================
//  QW电竞 - 完整后端 API (v7.9)
//  新增：店铺入驻、打手状态、说说、礼物系统、客服扣钻修复
// ============================================================

function generateId() { return Date.now().toString(36) + Math.random().toString(36).substring(2, 8); }
function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }
  });
}
function errorResponse(message, status = 400) { return jsonResponse({ error: message }, status); }
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
  // 公开注册仅允许 老板 / 打手；禁止注册管理员等角色
  let finalRole = role || 'boss';
  if (finalRole === 'admin' || finalRole === 'service' || finalRole === 'dispatcher') {
    finalRole = 'boss';
  }
  if (finalRole !== 'boss' && finalRole !== 'handler') {
    finalRole = 'boss';
  }
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) return errorResponse('用户名已存在');
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM users');
  const count = countResult.results?.[0]?.count || 0;
  const userId = String(100000 + count + 1);
  const userStatus = (finalRole === 'handler') ? 'pending' : (status || 'active');
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status, avatar, level, is_accepting, bio) VALUES (?, ?, ?, ?, 0, 0, ?, ?, 1, 0, "")',
    [userId, username, password, finalRole, userStatus, '']
  );
  return jsonResponse({
    message: finalRole === 'handler' ? '注册成功，请等待管理员审核' : '注册成功',
    id: userId,
    role: finalRole
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
  if ((user.role === 'handler' || user.role === 'dispatcher' || user.role === 'service') && user.status !== 'active') return errorResponse('账号待审核');
  const token = generateId() + '.' + user.id;
  return jsonResponse({
    token,
    user: { id: user.id, username: user.username, role: user.role || 'boss', diamond: user.diamond || 0, balance: user.balance || 0, status: user.status || 'active', banner: user.banner || '', avatar: user.avatar || '', club_prefix: user.club_prefix || '', level: user.level || 1, is_accepting: user.is_accepting || 0, bio: user.bio || '' }
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
  let user = null;
  try {
    const result = await queryDB(env,
      'SELECT id, username, role, diamond, level, status, avatar, banner, is_accepting, bio, last_active FROM users WHERE id = ?',
      [userId]);
    user = result.results && result.results[0];
  } catch (e) {
    const result = await queryDB(env,
      'SELECT id, username, role, diamond, level, status, avatar, banner, is_accepting, bio FROM users WHERE id = ?',
      [userId]);
    user = result.results && result.results[0];
  }
  if (!user) return errorResponse('用户不存在', 404);
  user.online = isUserOnline(user);
  user.is_accepting = Number(user.is_accepting) || 0;
  return jsonResponse(user);
}

// ============================================================
//  用户管理
// ============================================================
async function handleAdminGetUsers(env) {
  try {
    const result = await queryDB(env,
      'SELECT id, username, role, diamond, balance, status, created_at, banner, avatar, club_prefix, level, is_accepting, bio FROM users ORDER BY created_at DESC'
    );
    const users = (result.results || []).map(u => ({
      ...u,
      username: u.username || '未知',
      role: u.role || 'boss',
      diamond: Number(u.diamond) || 0,
      balance: Number(u.balance) || 0,
      status: u.status || 'active',
      level: Number(u.level) || 1,
    }));
    return jsonResponse(users);
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
  return jsonResponse({ success: true, message: '密码已重置' });
}

async function handleApproveHandler(env, targetUserId) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler' && user.role !== 'dispatcher' && user.role !== 'service') return errorResponse('该用户不是打手、派单员或客服', 403);
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
  await runDB(env, 'DELETE FROM shop_handlers WHERE handler_id = ?', [targetUserId]);
  await runDB(env, 'DELETE FROM users WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '用户已删除' });
}

// ============================================================
//  修改用户ID
// ============================================================
async function handleChangeUserId(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);

  const { targetUserId, newId } = body;
  if (!targetUserId || !newId) return errorResponse('请提供新ID');
  if (!/^\d+$/.test(newId)) return errorResponse('ID必须为数字');
  if (newId.length < 6) return errorResponse('ID至少6位');
  if (newId === targetUserId) return errorResponse('新ID与当前ID相同');

  const isSelf = targetUserId === userId;
  const isAdmin = user.role === 'admin';
  if (!isSelf && !isAdmin) return errorResponse('只能修改自己的ID', 403);

  const existing = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [newId]);
  if (existing.results && existing.results.length > 0) return errorResponse('该ID已被使用');

  const oldUserResult = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [targetUserId]);
  const oldUser = oldUserResult.results && oldUserResult.results[0];
  if (!oldUser) return errorResponse('用户不存在', 404);

  const cleanUsername = (oldUser.username || '').replace(/__tmp_\d+(_+tmp_\d+)*/g, '').trim();
  const finalUsername = cleanUsername || ('用户' + targetUserId.slice(-4));
  const tmpUsername = '__tmp_migrate_' + Date.now();

  try {
    await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [tmpUsername, targetUserId]);

    await runDB(env,
      `INSERT INTO users (id, username, password, role, diamond, balance, status, banner, avatar, club_prefix, level, is_accepting, bio, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [newId, finalUsername, oldUser.password, oldUser.role,
       oldUser.diamond || 0, oldUser.balance || 0, oldUser.status || 'active',
       oldUser.banner || '', oldUser.avatar || '', oldUser.club_prefix || '',
       oldUser.level || 1, oldUser.is_accepting || 0, oldUser.bio || '',
       oldUser.created_at || new Date().toISOString()]
    );

    const tables = [
      ['orders', 'boss_id'], ['orders', 'handler_id'],
      ['messages', 'sender_id'], ['messages', 'receiver_id'],
      ['message_contacts', 'user_id'], ['message_contacts', 'contact_id'],
      ['posts', 'user_id'], ['post_comments', 'user_id'], ['post_likes', 'user_id'],
      ['user_avatars', 'user_id'],
      ['recharge_requests', 'user_id'], ['withdraw_requests', 'user_id'],
      ['shops', 'owner_id'],
      ['shop_applications', 'applicant_id'],
      ['shop_handlers', 'handler_id'],
      ['shop_reviews', 'user_id'],
      ['shop_follows', 'user_id'],
      ['gift_records', 'from_user_id'],
      ['gift_records', 'to_user_id'],
    ];
    for (const [t, col] of tables) {
      try { await runDB(env, `UPDATE ${t} SET ${col} = ? WHERE ${col} = ?`, [newId, targetUserId]); } catch (e) {}
    }

    await runDB(env, 'DELETE FROM users WHERE id = ?', [targetUserId]);
  } catch (err) {
    try { await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [oldUser.username, targetUserId]); } catch (e) {}
    return errorResponse('修改失败: ' + err.message, 500);
  }

  return jsonResponse({ success: true, message: 'ID已修改，请重新登录' });
}

// ============================================================
//  头像 / 改名 / 背景墙 / 说说 / 接单状态
// ============================================================
async function handleUploadAvatar(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { avatar_url } = body;
  if (!avatar_url) return errorResponse('请提供头像URL');
  await runDB(env, 'INSERT INTO user_avatars (id, user_id, avatar_url, created_at) VALUES (?, ?, ?, ?)', [generateId(), userId, avatar_url, new Date().toISOString()]);
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

async function handleToggleAccepting(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'handler') return errorResponse('只有打手可切换', 403);
  const newStatus = user.is_accepting ? 0 : 1;
  await runDB(env, 'UPDATE users SET is_accepting = ? WHERE id = ?', [newStatus, userId]);
  return jsonResponse({ success: true, is_accepting: newStatus, message: newStatus ? '已开启接单' : '已暂停接单' });
}

async function handleUpdateBio(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { bio } = body;
  await runDB(env, 'UPDATE users SET bio = ? WHERE id = ?', [bio || '', userId]);
  return jsonResponse({ success: true, message: '说说已更新' });
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
      `INSERT INTO posts (id, user_id, content, images, category_id, likes, comments_count, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?, ?)`,
      [id, userId, content.trim(), imagesJson, category_id || null, now, now]
    );
  } catch (err) {
    await runDB(env,
      `INSERT INTO posts (id, user_id, content, images, category_id, likes, comments_count, status, created_at) VALUES (?, ?, ?, ?, ?, 0, 0, 'active', ?)`,
      [id, userId, content.trim(), imagesJson, category_id || null, now]
    );
  }
  return jsonResponse({ success: true, postId: id, message: '帖子发布成功' });
}

async function handleGetPosts(env, url) {
  const userId = url?.searchParams?.get('user_id');
  const currentUserId = url?.searchParams?.get('current_user');
  let sql = `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE (p.status = 'active' OR p.status IS NULL)
  `;
  const params = [];
  if (userId) {
    sql += ' AND p.user_id = ?';
    params.push(userId);
  }
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  const posts = result.results || [];

  if (currentUserId) {
    for (const post of posts) {
      try {
        const likeCheck = await queryDB(env, 'SELECT 1 FROM post_likes WHERE post_id = ? AND user_id = ?', [post.id, currentUserId]);
        post.is_liked = !!(likeCheck.results && likeCheck.results.length > 0);
      } catch (e) { post.is_liked = false; }
    }
  }
  return jsonResponse(posts);
}

async function handleGetPostDetail(env, postId) {
  const result = await queryDB(env, `
    SELECT p.*, u.username, u.avatar,
      (SELECT COUNT(*) FROM post_likes WHERE post_id = p.id) as likes_count,
      (SELECT COUNT(*) FROM post_comments WHERE post_id = p.id) as comments_count
    FROM posts p
    LEFT JOIN users u ON p.user_id = u.id
    WHERE p.id = ? AND (p.status = 'active' OR p.status IS NULL)
  `, [postId]);
  const post = result.results?.[0] || null;
  if (!post) return errorResponse('帖子不存在', 404);
  const commentsResult = await queryDB(env, `SELECT c.*, u.username, u.avatar FROM post_comments c LEFT JOIN users u ON c.user_id = u.id WHERE c.post_id = ? ORDER BY c.created_at ASC`, [postId]);
  post.comments = commentsResult.results || [];
  return jsonResponse(post);
}

async function handleLikePost(env, authHeader, postId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const check = await queryDB(env, 'SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
  let liked;
  if (check.results && check.results.length > 0) {
    await runDB(env, 'DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    liked = false;
  } else {
    await runDB(env, 'INSERT INTO post_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)', [generateId(), postId, userId, new Date().toISOString()]);
    liked = true;
  }
  const cnt = await queryDB(env, 'SELECT COUNT(*) as c FROM post_likes WHERE post_id = ?', [postId]);
  const likes_count = cnt.results?.[0]?.c || 0;
  await runDB(env, 'UPDATE posts SET likes = ? WHERE id = ?', [likes_count, postId]);
  return jsonResponse({ success: true, liked, likes_count });
}

async function handleCommentPost(env, authHeader, postId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { content } = body;
  if (!content || !content.trim()) return errorResponse('请输入评论内容');
  const id = generateId();
  await runDB(env, 'INSERT INTO post_comments (id, post_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)', [id, postId, userId, content.trim(), new Date().toISOString()]);
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
  await runDB(env, 'INSERT INTO post_categories (id, name, icon, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', [id, name, icon || '', sort_order || 0, new Date().toISOString()]);
  return jsonResponse({ success: true, id, message: '分类已创建' });
}
async function handleUpdatePostCategory(env, authHeader, catId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const { name, icon, sort_order } = body;
  await runDB(env, 'UPDATE post_categories SET name = ?, icon = ?, sort_order = ? WHERE id = ?', [name, icon || '', sort_order || 0, catId]);
  return jsonResponse({ success: true, message: '已更新' });
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
  await runDB(env, 'INSERT INTO categories (id, name, image, sort_order, parent_id, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, name, image || '', sort_order || 0, parent_id || null, new Date().toISOString()]);
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
     WHERE p.id = ?`, [productId]);
  const product = (result.results && result.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  let detailImages = [];
  if (product.detail_images) { try { detailImages = JSON.parse(product.detail_images); } catch(e) { detailImages = []; } }
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
     ORDER BY p.created_at DESC`);
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
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', detailImagesJson, detail_desc || '', category_id, shop_id || null, shop_category_id || null]);
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
  } else return errorResponse('请选择系统分类', 400);
  const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
  await runDB(env,
    `UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, category_id = ?, detail_images = ?, detail_desc = ?, shop_id = ?, shop_category_id = ? WHERE id = ?`,
    [finalGame, title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', finalCategoryId, detailImagesJson, detail_desc || '', shop_id || null, shop_category_id || null, productId]);
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
  const shops = (result.results || []).map(s => ({
    ...s,
    is_self: Number(s.is_self) || 0,
    is_recommend: Number(s.is_recommend) || 0,
    follow_count: Number(s.follow_count) || 0,
    owner_id: s.owner_id || ''
  }));
  return jsonResponse(shops);
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

// ============================================================
//  修复：handleCreateShop 传入 invite_code
// ============================================================
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
  const inviteCode = generateId().slice(0, 8).toUpperCase();
  await runDB(env,
    `INSERT INTO shops (id, owner_id, name, description, logo, banner, category_id, status, rating, sales, is_self, is_recommend, follow_count, invite_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '5.0', 0, ?, ?, 0, ?, ?)`,
    [shopId, userId, name, description || '', logo || '', banner || '', category_id,
     is_self ? 1 : 0, is_recommend ? 1 : 0, inviteCode, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id: shopId, invite_code: inviteCode, message: '店铺创建成功' });
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
    [name, description || '', logo || '', banner || '', category_id || null, is_self ? 1 : 0, is_recommend ? 1 : 0, shopId]);
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
  await runDB(env, 'DELETE FROM shops WHERE id = ?', [shopId]);
  return jsonResponse({ success: true, message: '店铺已删除' });
}

async function handleGetShopDetail(env, shopId) {
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) return errorResponse('店铺不存在', 404);
  const shop = result.results[0];
  shop.is_self = Number(shop.is_self) || 0;
  shop.is_recommend = Number(shop.is_recommend) || 0;
  shop.follow_count = Number(shop.follow_count) || 0;
  shop.owner_id = shop.owner_id || '';
  shop.category_id = shop.category_id || '';
  shop.invite_code = shop.invite_code || '';
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
     ORDER BY p.created_at DESC`, [shopId]);
  return jsonResponse(result.results || []);
}

async function handleGetShopCategories(env, shopId) {
  const result = await queryDB(env, 'SELECT * FROM shop_categories WHERE shop_id = ? ORDER BY sort_order ASC, created_at DESC', [shopId]);
  return jsonResponse(result.results || []);
}

async function handleCreateShopCategory(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'admin' && user.role !== 'dispatcher' && user.role !== 'service')) {
    return errorResponse('权限不足', 403);
  }
  const { shop_id, name, image_url, parent_id } = body;
  if (!shop_id) return errorResponse('请选择店铺');
  if (!name) return errorResponse('请输入分类名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO shop_categories (id, shop_id, name, image_url, sort_order, parent_id, created_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    [id, shop_id, name, image_url || '', parent_id || null, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: parent_id ? '子分类已添加' : '主分类已添加' });
}

async function handleUpdateShopCategory(env, authHeader, catId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin' && user.role !== 'dispatcher' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const { name, image_url, sort_order, parent_id } = body;
  let sql = 'UPDATE shop_categories SET ';
  const params = [];
  const updates = [];
  if (name !== undefined) { updates.push('name = ?'); params.push(name); }
  if (image_url !== undefined) { updates.push('image_url = ?'); params.push(image_url || ''); }
  if (sort_order !== undefined) { updates.push('sort_order = ?'); params.push(sort_order || 0); }
  if (parent_id !== undefined) { updates.push('parent_id = ?'); params.push(parent_id || null); }
  if (updates.length === 0) return errorResponse('没有要更新的字段');
  sql += updates.join(', ') + ' WHERE id = ?';
  params.push(catId);
  try {
    await runDB(env, sql, params);
  } catch (e) {
    return errorResponse('更新失败: ' + e.message, 500);
  }
  return jsonResponse({ success: true, message: '已更新' });
}

async function handleDeleteShopCategory(env, authHeader, categoryId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'admin' && user.role !== 'dispatcher' && user.role !== 'service')) return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM shop_categories WHERE id = ?', [categoryId]);
  return jsonResponse({ success: true, message: '店铺分类已删除' });
}

// ============================================================
//  店铺评价
// ============================================================
async function handleGetShopReviews(env, shopId) {
  const result = await queryDB(env,
    `SELECT r.*, u.username, u.avatar FROM shop_reviews r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.shop_id = ? ORDER BY r.created_at DESC`, [shopId]);
  return jsonResponse(result.results || []);
}

async function handleCreateReview(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { shop_id, order_id, rating, content, images } = body;
  if (!rating) return errorResponse('请填写评分');
  let order = null;
  if (order_id) {
    const o = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [order_id]);
    order = (o.results && o.results[0]) || null;
    if (order && order.reviewed) return errorResponse('该订单已评价');
    if (order) await runDB(env, 'UPDATE orders SET reviewed = 1 WHERE id = ?', [order_id]);
  }
  const id = generateId();
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  // 店铺评价（有 shop_id 时）
  if (shop_id) {
    await runDB(env,
      'INSERT INTO shop_reviews (id, shop_id, order_id, user_id, rating, content, images, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [id, shop_id, order_id || null, userId, parseInt(rating), content || '', imagesJson, new Date().toISOString()]);
  }
  // 同步到接单打手评价
  const handlerId = order && order.handler_id;
  if (handlerId) {
    await ensureExtraTables(env);
    try {
      await runDB(env,
        'INSERT INTO handler_reviews (id, handler_id, order_id, user_id, rating, content, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [generateId(), handlerId, order_id || null, userId, parseInt(rating), content || '', new Date().toISOString()]);
    } catch (e) {}
  }
  return jsonResponse({ success: true, id, message: '评价成功' });
}

async function handleGetHandlerReviews(env, handlerId) {
  await ensureExtraTables(env);
  try {
    const result = await queryDB(env,
      `SELECT r.*, u.username, u.avatar FROM handler_reviews r
       LEFT JOIN users u ON r.user_id = u.id
       WHERE r.handler_id = ?
       ORDER BY r.created_at DESC`, [handlerId]);
    return jsonResponse(result.results || []);
  } catch (e) {
    return jsonResponse([]);
  }
}

async function handleHeartbeat(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  await touchOnline(env, userId);
  return jsonResponse({ success: true, time: new Date().toISOString() });
}

async function handleGetAutoReplies(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'admin' && user.role !== 'service')) return errorResponse('权限不足', 403);
  await ensureExtraTables(env);
  const result = await queryDB(env, 'SELECT * FROM auto_replies ORDER BY sort_order ASC, created_at ASC');
  return jsonResponse(result.results || []);
}

async function handleSaveAutoReply(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'admin' && user.role !== 'service')) return errorResponse('权限不足', 403);
  await ensureExtraTables(env);
  const { id, question, answer, keywords, sort_order } = body;
  if (!question || !answer) return errorResponse('请填写问题和回答');
  if (id) {
    await runDB(env, 'UPDATE auto_replies SET question = ?, answer = ?, keywords = ?, sort_order = ? WHERE id = ?',
      [question, answer, keywords || question, sort_order || 0, id]);
    return jsonResponse({ success: true, message: '已更新' });
  }
  const newId = generateId();
  await runDB(env, 'INSERT INTO auto_replies (id, question, answer, keywords, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [newId, question, answer, keywords || question, sort_order || 0, new Date().toISOString()]);
  return jsonResponse({ success: true, id: newId, message: '已添加' });
}

async function handleDeleteAutoReply(env, authHeader, replyId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || (user.role !== 'admin' && user.role !== 'service')) return errorResponse('权限不足', 403);
  await runDB(env, 'DELETE FROM auto_replies WHERE id = ?', [replyId]);
  return jsonResponse({ success: true, message: '已删除' });
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
    await runDB(env, 'INSERT INTO shop_follows (id, user_id, shop_id, created_at) VALUES (?, ?, ?, ?)', [generateId(), userId, shopId, new Date().toISOString()]);
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
//  店铺入驻（新）
// ============================================================
async function handleJoinShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'handler') return errorResponse('只有打手可以入驻店铺', 403);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!shopResult.results || shopResult.results.length === 0) return errorResponse('店铺不存在', 404);
  const existing = await queryDB(env, 'SELECT * FROM shop_handlers WHERE shop_id = ? AND handler_id = ?', [shopId, userId]);
  if (existing.results && existing.results.length > 0) return errorResponse('您已入驻该店铺');
  await runDB(env,
    'INSERT INTO shop_handlers (id, shop_id, handler_id, status, created_at) VALUES (?, ?, ?, "active", ?)',
    [generateId(), shopId, userId, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '入驻成功' });
}

async function handleLeaveShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  await runDB(env, 'DELETE FROM shop_handlers WHERE shop_id = ? AND handler_id = ?', [shopId, userId]);
  return jsonResponse({ success: true, message: '已退出店铺' });
}

async function handleGetShopHandlers(env, shopId) {
  let result;
  try {
    result = await queryDB(env,
      `SELECT u.id, u.username, u.avatar, u.level, u.status, u.is_accepting, u.last_active,
              (SELECT COUNT(*) FROM orders WHERE handler_id = u.id AND status = 'completed') as completed_orders
       FROM shop_handlers sh
       LEFT JOIN users u ON sh.handler_id = u.id
       WHERE sh.shop_id = ? AND sh.status = 'active'`,
      [shopId]
    );
  } catch (e) {
    result = await queryDB(env,
      `SELECT u.id, u.username, u.avatar, u.level, u.status, u.is_accepting,
              (SELECT COUNT(*) FROM orders WHERE handler_id = u.id AND status = 'completed') as completed_orders
       FROM shop_handlers sh
       LEFT JOIN users u ON sh.handler_id = u.id
       WHERE sh.shop_id = ? AND sh.status = 'active'`,
      [shopId]
    );
  }
  const list = (result.results || []).map(h => {
    const online = isUserOnline(h);
    const accepting = Number(h.is_accepting) === 1;
    let sortKey = 2; // 不在线
    if (accepting) sortKey = 0;
    else if (online) sortKey = 1;
    return { ...h, online, is_accepting: accepting ? 1 : 0, sortKey };
  });
  // 接单中 > 在线 > 不在线
  list.sort((a, b) => a.sortKey - b.sortKey);
  return jsonResponse(list);
}

async function handleGetHandlerShops(env, handlerId) {
  const result = await queryDB(env,
    `SELECT s.* FROM shop_handlers sh
     LEFT JOIN shops s ON sh.shop_id = s.id
     WHERE sh.handler_id = ? AND sh.status = 'active'`,
    [handlerId]
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  我的店铺系统
// ============================================================
async function handleMyShop(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return jsonResponse({ hasShop: false });
  shop.is_self = Number(shop.is_self) || 0;
  shop.is_recommend = Number(shop.is_recommend) || 0;
  return jsonResponse({ hasShop: true, shop });
}

async function handleApplyShop(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const role = user.role || 'boss';
  if (role === 'handler') return errorResponse('打手不能创建店铺', 403);
  if (role === 'boss') return errorResponse('老板不能创建店铺', 403);

  const existing = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ?', [userId]);
  if (existing.results && existing.results.length > 0) return errorResponse('您已拥有店铺');

  const pending = await queryDB(env, 'SELECT * FROM shop_applications WHERE applicant_id = ? AND status = "pending"', [userId]);
  if (pending.results && pending.results.length > 0) return errorResponse('已有待审核的申请');

  const { shop_name, description, logo, banner } = body;
  if (!shop_name) return errorResponse('请输入店铺名称');
  const id = generateId();
  await runDB(env,
    'INSERT INTO shop_applications (id, applicant_id, shop_name, description, logo, banner, status, created_at) VALUES (?, ?, ?, ?, ?, ?, "pending", ?)',
    [id, userId, shop_name, description || '', logo || '', banner || '', new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '申请已提交，请等待管理员审核' });
}

async function handleGetMyShopProducts(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return jsonResponse([]);
  const result = await queryDB(env, 'SELECT * FROM products WHERE shop_id = ? ORDER BY created_at DESC', [shop.id]);
  return jsonResponse(result.results || []);
}

async function handleGetMyShopOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return jsonResponse([]);
  const result = await queryDB(env,
    `SELECT o.* FROM orders o
     LEFT JOIN products p ON o.product_id = p.id
     WHERE p.shop_id = ?
     ORDER BY o.created_at DESC`, [shop.id]);
  return jsonResponse(result.results || []);
}

async function handleGetMyShopHandlers(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return jsonResponse([]);
  const result = await queryDB(env,
    `SELECT u.id, u.username, u.avatar, u.diamond FROM shop_handlers sh
     LEFT JOIN users u ON sh.handler_id = u.id
     WHERE sh.shop_id = ? AND sh.status = 'active'`, [shop.id]);
  return jsonResponse(result.results || []);
}

async function handleMyShopUpdate(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return errorResponse('您没有店铺', 403);
  const { name, description, logo, banner } = body;
  await runDB(env,
    'UPDATE shops SET name = ?, description = ?, logo = ?, banner = ? WHERE id = ?',
    [name || shop.name, description || '', logo || '', banner || '', shop.id]
  );
  return jsonResponse({ success: true, message: '已更新' });
}

async function handleInviteHandler(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE owner_id = ? LIMIT 1', [userId]);
  const shop = shopResult.results?.[0];
  if (!shop) return errorResponse('您没有店铺', 403);
  const { handler_id } = body;
  if (!handler_id) return errorResponse('请选择打手');
  const h = await getUserById(env, handler_id);
  if (!h || h.role !== 'handler') return errorResponse('该用户不是打手');
  const existing = await queryDB(env, 'SELECT * FROM shop_handlers WHERE shop_id = ? AND handler_id = ?', [shop.id, handler_id]);
  if (existing.results && existing.results.length > 0) return errorResponse('该打手已入驻');
  await runDB(env,
    'INSERT INTO shop_handlers (id, shop_id, handler_id, status, created_at) VALUES (?, ?, ?, "active", ?)',
    [generateId(), shop.id, handler_id, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '已邀请打手入驻' });
}

async function handleGetAllShopApplications(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const result = await queryDB(env,
    `SELECT a.*, u.username as applicant_name FROM shop_applications a
     LEFT JOIN users u ON a.applicant_id = u.id
     WHERE a.status = 'pending' ORDER BY a.created_at DESC`);
  return jsonResponse(result.results || []);
}

async function handleApproveShopApplication(env, authHeader, appId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const appResult = await queryDB(env, 'SELECT * FROM shop_applications WHERE id = ?', [appId]);
  const app = appResult.results?.[0];
  if (!app || app.status !== 'pending') return errorResponse('申请不存在或已处理');

  const applicant = await getUserById(env, app.applicant_id);
  if (!applicant || !['admin', 'dispatcher', 'service'].includes(applicant.role)) {
    return errorResponse('申请人角色不允许创建店铺');
  }

  const countResult = await queryDB(env, 'SELECT COUNT(*) as c FROM shops');
  const count = countResult.results?.[0]?.c || 0;
  const shopId = 'a' + String(100000 + count + 1);
  const inviteCode = generateId().slice(0, 8).toUpperCase();

  await runDB(env,
    `INSERT INTO shops (id, owner_id, name, description, logo, banner, status, rating, sales, is_self, is_recommend, follow_count, invite_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', '5.0', 0, 0, 0, 0, ?, ?)`,
    [shopId, app.applicant_id, app.shop_name, app.description || '', app.logo || '', app.banner || '', inviteCode, new Date().toISOString()]
  );
  await runDB(env, 'UPDATE shop_applications SET status = "approved", handled_at = ? WHERE id = ?',
    [new Date().toISOString(), appId]);
  return jsonResponse({ success: true, shopId, message: '已通过' });
}

async function handleRejectShopApplication(env, authHeader, appId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  await runDB(env, 'UPDATE shop_applications SET status = "rejected", reject_reason = ?, handled_at = ? WHERE id = ?',
    [body.reason || '无原因', new Date().toISOString(), appId]);
  return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleChangeShopOwner(env, authHeader, shopId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const { new_owner_id } = body;
  if (!new_owner_id) return errorResponse('请选择新拥有者');
  const u = await getUserById(env, new_owner_id);
  if (!u) return errorResponse('用户不存在');
  await runDB(env, 'UPDATE shops SET owner_id = ? WHERE id = ?', [new_owner_id, shopId]);
  return jsonResponse({ success: true, message: `拥有者已更改为 ${u.username}` });
}

// ============================================================
//  订单
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

  const diamondCost = Number(product.price);
  if ((user.diamond || 0) < diamondCost) {
    return errorResponse(`红钻不足，需要 ${diamondCost} 红钻，当前仅有 ${user.diamond || 0} 红钻`);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);
  const orderId = generateId();
  await runDB(env,
    `INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages, handler_id)
     VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
    [orderId, productId, userId, product.price, product.game, product.title, product.desc || '',
     JSON.stringify([{ sender: 'system', content: '订单已创建', time: new Date().toISOString() }]),
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

  if (user.role === 'admin') {
    const result = await queryDB(env,
      `SELECT o.*, b.username as boss_name, h.username as handler_name
       FROM orders o
       LEFT JOIN users b ON o.boss_id = b.id
       LEFT JOIN users h ON o.handler_id = h.id
       ORDER BY o.created_at DESC`);
    return jsonResponse(result.results || []);
  }

  if (user.role === 'boss' || user.role === 'service' || user.role === 'dispatcher') {
    const result = await queryDB(env,
      `SELECT o.*, b.username as boss_name, h.username as handler_name
       FROM orders o
       LEFT JOIN users b ON o.boss_id = b.id
       LEFT JOIN users h ON o.handler_id = h.id
       WHERE o.boss_id = ? ORDER BY o.created_at DESC`, [userId]);
    return jsonResponse(result.results || []);
  }
  if (user.role === 'handler') {
    const pendingResult = await queryDB(env,
      `SELECT o.*, b.username as boss_name, h.username as handler_name
       FROM orders o
       LEFT JOIN users b ON o.boss_id = b.id
       LEFT JOIN users h ON o.handler_id = h.id
       WHERE o.status = 'pending' ORDER BY o.created_at DESC`);
    const myResult = await queryDB(env,
      `SELECT o.*, b.username as boss_name, h.username AS handler_name
       FROM orders o
       LEFT JOIN users b ON o.boss_id = b.id
       LEFT JOIN users h ON o.handler_id = h.id
       WHERE o.handler_id = ? ORDER BY o.created_at DESC`, [userId]);
    const all = [...(pendingResult.results || []), ...(myResult.results || [])];
    const seen = new Set();
    return jsonResponse(all.filter(o => { if (seen.has(o.id)) return false; seen.add(o.id); return true; }));
  }
  return errorResponse('无权查看', 403);
}

async function handleGetOrderDetail(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const result = await queryDB(env,
    `SELECT o.*, b.username as boss_name, h.username as handler_name
     FROM orders o
     LEFT JOIN users b ON o.boss_id = b.id
     LEFT JOIN users h ON o.handler_id = h.id
     WHERE o.id = ?`, [orderId]);
  const order = result.results && result.results[0];
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
  if (user.role !== 'boss' && user.role !== 'service' && user.role !== 'admin') return errorResponse('只有老板、客服或管理员可操作', 403);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId && user.role !== 'admin' && user.role !== 'service') return errorResponse('不是你的订单', 403);
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成' });
}
async function handleRefundRequest(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss' && user.role !== 'service' && user.role !== 'admin') return errorResponse('只有老板、客服或管理员可发起退款', 403);
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
//  管理员订单操作
// ============================================================
async function handleAdminConfirm(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!result.results || result.results.length === 0) return errorResponse('订单不存在', 404);
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
    [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '验收通过' });
}

async function handleAdminForceComplete(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  if (!result.results || result.results.length === 0) return errorResponse('订单不存在', 404);
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
    [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '强制完成成功' });
}

async function handleAdminDeleteOrder(env, orderId) {
  await runDB(env, 'DELETE FROM orders WHERE id = ?', [orderId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  派单
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
  // 已清除派单发布时的扣红钻逻辑
  const orderId = generateId();
  let status = 'pending';
  let handlerId = assignedHandlerId || null;
  let messages = JSON.stringify([{ sender: 'system', content: `派单员发布订单：${title}`, time: new Date().toISOString() }]);
  if (handlerId) {
    const handlerCheck = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler" AND status = "active"', [handlerId]);
    if (handlerCheck.results && handlerCheck.results.length > 0) {
      status = 'ongoing';
      messages = JSON.stringify([{ sender: 'system', content: `派单员发布订单：${title}，已指派打手`, time: new Date().toISOString() }]);
    } else handlerId = null;
  }
  await runDB(env,
    `INSERT INTO orders (id, boss_id, handler_id, status, price, game, title, description, messages, start_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, userId, handlerId, status, parseFloat(price), game || '暗区突围', title, desc || '', messages, handlerId ? new Date().toISOString() : null]);
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
     FROM orders WHERE boss_id = ?`, [userId]);
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
  // 已清除派单确认时的扣红钻、给打手加钻逻辑
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ?, settled = 1 WHERE id = ?', [new Date().toISOString(), orderId]);
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
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') return errorResponse('无权操作', 403);
  const sender = user.role === 'boss' ? 'boss' : user.role === 'handler' ? 'handler' : user.role === 'dispatcher' ? 'dispatcher' : user.role === 'service' ? 'service' : 'admin';
  let messages = [];
  try { messages = JSON.parse(order.messages || '[]'); } catch (e) { messages = []; }
  messages.push({ sender, content, time: new Date().toISOString() });
  await runDB(env, 'UPDATE orders SET messages = ? WHERE id = ?', [JSON.stringify(messages), orderId]);
  return jsonResponse({ message: '发送成功' });
}

// ============================================================
//  打手接单大厅
// ============================================================
async function handleGetPendingOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'handler') return errorResponse('只有打手可查看', 403);
  const result = await queryDB(env,
    `SELECT o.*, b.username as boss_name
     FROM orders o
     LEFT JOIN users b ON o.boss_id = b.id
     WHERE o.status = 'pending'
     ORDER BY o.created_at DESC`);
  return jsonResponse(result.results || []);
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
  await runDB(env, 'INSERT INTO recharge_requests (id, user_id, amount, diamond, status, created_at) VALUES (?, ?, ?, ?, "pending", ?)', [id, userId, amount, diamond, new Date().toISOString()]);
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
  await runDB(env, 'INSERT INTO recharge_images (id, image_url, sort_order, created_at) VALUES (?, ?, ?, ?)', [id, image_url, sort_order || 0, new Date().toISOString()]);
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
    `SELECT r.*, u.username FROM recharge_requests r
     LEFT JOIN users u ON r.user_id = u.id
     WHERE r.status = 'pending' ORDER BY r.created_at DESC`);
  return jsonResponse(result.results || []);
}

// ============================================================
//  修复：客服同意充值扣钻逻辑
// ============================================================
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
    // 客服/管理员扣自己的红钻（模拟充值来源）
    if ((user.diamond || 0) < request.diamond) {
      return errorResponse(`您的红钻不足（需 ${request.diamond}，当前 ${user.diamond || 0}）`);
    }
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [request.diamond, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.diamond, request.user_id]);
    await runDB(env,
      'UPDATE recharge_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?',
      [userId, new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: `已通过，扣除您 ${request.diamond} 红钻` });
  } else {
    await runDB(env,
      'UPDATE recharge_requests SET status = "rejected", handler_id = ?, reject_reason = ?, handled_at = ? WHERE id = ?',
      [userId, rejectReason || '无原因', new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: '已拒绝' });
  }
}
async function handleGetUsersForService(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') return errorResponse('权限不足', 403);
  const result = await queryDB(env, 'SELECT id, username, role FROM users WHERE role NOT IN ("admin", "service", "handler")');
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
// 客服机器人固定 ID
const CS_BOT_ID = 'cs_bot';
const ONLINE_THRESHOLD_MS = 3 * 60 * 1000;

async function ensureExtraTables(env) {
  try {
    await runDB(env, `CREATE TABLE IF NOT EXISTS auto_replies (
      id TEXT PRIMARY KEY, question TEXT, answer TEXT, keywords TEXT, sort_order INTEGER DEFAULT 0, created_at TEXT
    )`);
  } catch (e) {}
  try {
    await runDB(env, `CREATE TABLE IF NOT EXISTS cs_sessions (
      id TEXT PRIMARY KEY, user_id TEXT, agent_id TEXT, status TEXT, requested_at TEXT, connected_at TEXT
    )`);
  } catch (e) {}
  try {
    await runDB(env, `CREATE TABLE IF NOT EXISTS handler_reviews (
      id TEXT PRIMARY KEY, handler_id TEXT, order_id TEXT, user_id TEXT, rating INTEGER, content TEXT, created_at TEXT
    )`);
  } catch (e) {}
}

/** 确保客服机器人在 users 表中存在，避免消息外键约束失败 */
async function ensureCsBotUser(env) {
  try {
    const exist = await queryDB(env, 'SELECT id FROM users WHERE id = ?', [CS_BOT_ID]);
    if (exist.results && exist.results.length > 0) return true;
  } catch (e) {}
  // 多种插入方式，兼容不同表结构
  const tries = [
    async () => runDB(env,
      `INSERT OR IGNORE INTO users (id, username, password, role, diamond, balance, status, avatar, level, is_accepting, bio)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, 1, 0, ?)`,
      [CS_BOT_ID, '在线客服', '__system_bot__', 'service', 'active', '', '智能客服机器人']),
    async () => runDB(env,
      `INSERT OR IGNORE INTO users (id, username, password, role, diamond, balance, status, avatar, level, is_accepting, bio, created_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, ?, 1, 0, ?, ?)`,
      [CS_BOT_ID, '在线客服', '__system_bot__', 'service', 'active', '', '智能客服机器人', new Date().toISOString()]),
    async () => runDB(env,
      `INSERT OR IGNORE INTO users (id, username, password, role, status) VALUES (?, ?, ?, ?, ?)`,
      [CS_BOT_ID, '在线客服', '__system_bot__', 'service', 'active']),
    async () => runDB(env,
      `INSERT OR IGNORE INTO users (id, username, password, role) VALUES (?, ?, ?, ?)`,
      [CS_BOT_ID, '在线客服', '__system_bot__', 'service']),
  ];
  for (const fn of tries) {
    try { await fn(); } catch (e) {}
  }
  try {
    const check = await queryDB(env, 'SELECT id FROM users WHERE id = ?', [CS_BOT_ID]);
    return !!(check.results && check.results.length > 0);
  } catch (e) {
    return false;
  }
}

async function touchOnline(env, userId) {
  if (!userId || userId === CS_BOT_ID) return;
  try { await runDB(env, 'UPDATE users SET last_active = ? WHERE id = ?', [new Date().toISOString(), userId]); } catch (e) {}
}

function isUserOnline(user) {
  if (!user || !user.last_active) return false;
  const t = new Date(user.last_active).getTime();
  if (isNaN(t)) return false;
  return (Date.now() - t) < ONLINE_THRESHOLD_MS;
}

async function upsertContact(env, userId, contactId, lastMsg, unreadInc) {
  const c = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [userId, contactId]);
  if (!c.results || c.results.length === 0) {
    await runDB(env, 'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, ?)',
      [generateId(), userId, contactId, lastMsg, new Date().toISOString(), unreadInc || 0]);
  } else if (unreadInc) {
    await runDB(env, 'UPDATE message_contacts SET last_message = ?, last_time = ?, unread_count = unread_count + ? WHERE user_id = ? AND contact_id = ?',
      [lastMsg, new Date().toISOString(), unreadInc, userId, contactId]);
  } else {
    await runDB(env, 'UPDATE message_contacts SET last_message = ?, last_time = ? WHERE user_id = ? AND contact_id = ?',
      [lastMsg, new Date().toISOString(), userId, contactId]);
  }
}

async function insertMessage(env, senderId, receiverId, content) {
  const id = generateId();
  await runDB(env, 'INSERT INTO messages (id, sender_id, receiver_id, content, is_read, created_at) VALUES (?, ?, ?, ?, 0, ?)',
    [id, senderId, receiverId, content, new Date().toISOString()]);
  return id;
}

async function matchAutoReply(env, text) {
  await ensureExtraTables(env);
  const result = await queryDB(env, 'SELECT * FROM auto_replies ORDER BY sort_order ASC, created_at ASC');
  const list = result.results || [];
  const lower = (text || '').toLowerCase();
  for (const item of list) {
    const kws = (item.keywords || item.question || '').split(/[,，;；\s]+/).filter(Boolean);
    if (kws.length === 0) continue;
    if (kws.some(k => lower.includes(String(k).toLowerCase()))) return item.answer || '';
  }
  return '您好，我是智能客服。您可以描述问题，或发送「转人工」联系在线客服。';
}

async function findOnlineServiceAgent(env) {
  const result = await queryDB(env, 'SELECT * FROM users WHERE role IN ("service", "admin") AND status = "active"');
  const users = (result.results || []).filter(u => u.id !== CS_BOT_ID);
  const online = users.filter(u => u.role === 'service' && isUserOnline(u));
  if (online.length > 0) return online[Math.floor(Math.random() * online.length)];
  const onlineAdmin = users.filter(u => u.role === 'admin' && isUserOnline(u));
  if (onlineAdmin.length > 0) return onlineAdmin[Math.floor(Math.random() * onlineAdmin.length)];
  return null;
}

async function handleSendMessage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  await touchOnline(env, userId);
  const { receiverId, content } = body;
  if (!receiverId || !content || !String(content).trim()) return errorResponse('请完整填写');
  const text = String(content).trim();
  if (userId === receiverId) return errorResponse('不能给自己发消息', 403);

  // 客服机器人 + 自动回复 + 转人工
  if (receiverId === CS_BOT_ID) {
    await ensureExtraTables(env);
    const botOk = await ensureCsBotUser(env);
    if (!botOk) {
      return errorResponse('客服系统初始化失败，请联系管理员在数据库中确认 users 表可写入', 500);
    }
    try {
      await insertMessage(env, userId, CS_BOT_ID, text);
    } catch (e) {
      // 外键仍失败时再尝试一次初始化
      await ensureCsBotUser(env);
      await insertMessage(env, userId, CS_BOT_ID, text);
    }
    await upsertContact(env, userId, CS_BOT_ID, text, 0);

    if (/转人工|人工客服|转接人工|找客服/.test(text)) {
      const agent = await findOnlineServiceAgent(env);
      if (agent) {
        await runDB(env, 'INSERT INTO cs_sessions (id, user_id, agent_id, status, requested_at, connected_at) VALUES (?, ?, ?, ?, ?, ?)',
          [generateId(), userId, agent.id, 'connected', new Date().toISOString(), new Date().toISOString()]);
        const tip = `已为您转接人工客服「${agent.username}」，正在为您接入...`;
        await insertMessage(env, CS_BOT_ID, userId, tip);
        await upsertContact(env, userId, CS_BOT_ID, tip, 1);
        const intro = `[系统] 用户 ${user.username}(${userId}) 请求人工客服`;
        await insertMessage(env, userId, agent.id, intro);
        await upsertContact(env, userId, agent.id, intro, 0);
        await upsertContact(env, agent.id, userId, intro, 1);
        return jsonResponse({ success: true, message: '已转人工', transferred: true, agent_id: agent.id, agent_name: agent.username });
      } else {
        await runDB(env, 'INSERT INTO cs_sessions (id, user_id, agent_id, status, requested_at, connected_at) VALUES (?, ?, ?, ?, ?, ?)',
          [generateId(), userId, null, 'waiting', new Date().toISOString(), null]);
        const tip = '目前客服不在线，请稍等。有客服上线后会尽快为您接入（预计不超过5分钟）。';
        await insertMessage(env, CS_BOT_ID, userId, tip);
        await upsertContact(env, userId, CS_BOT_ID, tip, 1);
        return jsonResponse({ success: true, message: '客服不在线', offline: true });
      }
    }

    const answer = await matchAutoReply(env, text);
    await insertMessage(env, CS_BOT_ID, userId, answer);
    await upsertContact(env, userId, CS_BOT_ID, answer, 1);
    return jsonResponse({ success: true, message: '发送成功', auto_reply: true });
  }

  const receiver = await getUserById(env, receiverId);
  if (!receiver) return errorResponse('接收者不存在', 404);
  await insertMessage(env, userId, receiverId, text);
  await upsertContact(env, userId, receiverId, text, 0);
  await upsertContact(env, receiverId, userId, text, 1);
  return jsonResponse({ success: true, message: '发送成功' });
}
async function handleGetContacts(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  await touchOnline(env, userId);
  const sql = `
    WITH all_contacts AS (
      SELECT DISTINCT sender_id as contact_id FROM messages WHERE receiver_id = ?
      UNION
      SELECT DISTINCT receiver_id as contact_id FROM messages WHERE sender_id = ?
    )
    SELECT u.id, u.username, u.role, u.avatar, u.last_active, mc.last_message, mc.last_time, mc.unread_count
    FROM all_contacts ac
    JOIN users u ON u.id = ac.contact_id
    LEFT JOIN message_contacts mc ON mc.user_id = ? AND mc.contact_id = ac.contact_id
    WHERE u.id != ?
    ORDER BY COALESCE(mc.last_time, '1970-01-01') DESC`;
  let list = [];
  try {
    const result = await queryDB(env, sql, [userId, userId, userId, userId]);
    list = (result.results || []).map(c => ({ ...c, online: isUserOnline(c) }));
  } catch (e) {
    // last_active 列可能不存在，降级查询
    const sql2 = `
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
      ORDER BY COALESCE(mc.last_time, '1970-01-01') DESC`;
    const result = await queryDB(env, sql2, [userId, userId, userId, userId]);
    list = (result.results || []).map(c => ({ ...c, online: false }));
  }

  // 置顶客服机器人联系人（确保 users 表有 cs_bot 记录）
  try { await ensureCsBotUser(env); } catch (e) {}
  const csMc = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [userId, CS_BOT_ID]);
  const csRow = (csMc.results && csMc.results[0]) || {};
  const csContact = {
    id: CS_BOT_ID,
    username: '在线客服',
    role: 'service',
    avatar: '',
    last_message: csRow.last_message || '您好，有什么可以帮您？发送「转人工」可联系人工客服',
    last_time: csRow.last_time || null,
    unread_count: csRow.unread_count || 0,
    online: true,
    is_cs_bot: true
  };
  list = list.filter(c => c.id !== CS_BOT_ID);
  return jsonResponse([csContact, ...list]);
}
async function handleGetMessages(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { contactId, type, orderId } = body;

  if (type === 'order' && orderId) {
    const o = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
    const order = o.results && o.results[0];
    if (!order) return errorResponse('订单不存在', 404);
    if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin' && user.role !== 'service') {
      return errorResponse('无权查看', 403);
    }
    let messages = [];
    try { messages = JSON.parse(order.messages || '[]'); } catch (e) {}
    const formatted = messages.map(m => ({
      id: generateId(),
      sender_id: m.sender === 'boss' ? order.boss_id : (m.sender === 'handler' ? order.handler_id : 'system'),
      sender_name: m.sender,
      content: m.content,
      created_at: m.time || new Date().toISOString()
    }));
    return jsonResponse(formatted);
  }

  if (!contactId) return errorResponse('请选择联系人');
  // 客服机器人特殊处理
  if (contactId === CS_BOT_ID) {
    try { await ensureCsBotUser(env); } catch (e) {}
    const result = await queryDB(env,
      `SELECT m.*, 
        CASE WHEN m.sender_id = ? THEN '在线客服' ELSE COALESCE(u.username, m.sender_id) END as sender_name,
        u.avatar as sender_avatar
       FROM messages m
       LEFT JOIN users u ON m.sender_id = u.id
       WHERE (m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?)
       ORDER BY m.created_at ASC`,
      [CS_BOT_ID, userId, CS_BOT_ID, CS_BOT_ID, userId]
    );
    await runDB(env, 'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?', [CS_BOT_ID, userId]);
    await runDB(env, 'UPDATE message_contacts SET unread_count = 0 WHERE user_id = ? AND contact_id = ?', [userId, CS_BOT_ID]);
    return jsonResponse((result.results || []).map(m => ({
      ...m,
      sender_name: m.sender_id === CS_BOT_ID ? '在线客服' : m.sender_name
    })));
  }
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
  const result = await queryDB(env, 'SELECT id, username, role FROM users WHERE role IN ("admin", "service") AND status = "active"');
  return jsonResponse(result.results || []);
}

// ============================================================
//  礼物系统（新）
// ============================================================
async function handleGetGifts(env) {
  const result = await queryDB(env, 'SELECT * FROM gifts ORDER BY sort_order ASC, created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminCreateGift(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  const { name, image_url, price, sort_order } = body;
  if (!name || !image_url) return errorResponse('请填写完整');
  const id = generateId();
  await runDB(env,
    'INSERT INTO gifts (id, name, image_url, price, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    [id, name, image_url, price || 0, sort_order || 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '礼物已添加' });
}

async function handleAdminDeleteGift(env, authHeader, giftId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user || user.role !== 'admin') return errorResponse('权限不足', 403);
  // 同步删除赠送记录，个人主页礼物列表不再显示已删除礼物
  try { await runDB(env, 'DELETE FROM gift_records WHERE gift_id = ?', [giftId]); } catch (e) {}
  await runDB(env, 'DELETE FROM gifts WHERE id = ?', [giftId]);
  return jsonResponse({ success: true, message: '已删除' });
}

async function handleSendGift(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { gift_id, to_user_id } = body;
  if (!gift_id || !to_user_id) return errorResponse('参数不完整');
  if (userId === to_user_id) return errorResponse('不能给自己送礼物');
  const gift = await queryDB(env, 'SELECT * FROM gifts WHERE id = ?', [gift_id]);
  const g = gift.results?.[0];
  if (!g) return errorResponse('礼物不存在');
  const user = await getUserById(env, userId);
  if ((user.diamond || 0) < (g.price || 0)) return errorResponse('红钻不足');
  if (g.price > 0) {
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [g.price, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [g.price, to_user_id]);
  }
  await runDB(env,
    'INSERT INTO gift_records (id, gift_id, from_user_id, to_user_id, created_at) VALUES (?, ?, ?, ?, ?)',
    [generateId(), gift_id, userId, to_user_id, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '礼物已送达' });
}

async function handleGetUserGifts(env, userId) {
  // 只返回仍存在的礼物（已删除的礼物不显示）
  const result = await queryDB(env,
    `SELECT g.*, COUNT(gr.id) as count FROM gift_records gr
     INNER JOIN gifts g ON gr.gift_id = g.id
     WHERE gr.to_user_id = ?
     GROUP BY g.id
     ORDER BY count DESC`,
    [userId]
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
  // 取消冻结100红钻限制，可提现全部余额
  const available = Math.max(0, Number(user.diamond) || 0);
  if (amount > available) return errorResponse(`可提现红钻不足，可用：${available}`, 400);
  const id = generateId();
  await runDB(env, 'INSERT INTO withdraw_requests (id, user_id, amount, status, created_at) VALUES (?, ?, ?, "pending", ?)', [id, userId, amount, new Date().toISOString()]);
  return jsonResponse({ success: true, message: '提现申请已提交' });
}
async function handleAdminGetWithdrawals(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  const result = await queryDB(env, `SELECT w.*, u.username FROM withdraw_requests w LEFT JOIN users u ON w.user_id = u.id ORDER BY w.created_at DESC`);
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
  await runDB(env, 'UPDATE withdraw_requests SET status = "approved", handled_at = ? WHERE id = ?', [new Date().toISOString(), withdrawId]);
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
  await runDB(env, 'UPDATE withdraw_requests SET status = "rejected", reject_reason = ?, handled_at = ? WHERE id = ?', [reason || '无原因', new Date().toISOString(), withdrawId]);
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
  await runDB(env, 'INSERT INTO banners (id, image_url, link, sort_order, created_at) VALUES (?, ?, ?, ?, ?)', [id, image_url, link || '', sort_order || 0, new Date().toISOString()]);
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
    await runDB(env, 'INSERT INTO custom_icons (id, key, image_url, created_at) VALUES (?, ?, ?, ?)', [generateId(), key, image_url, new Date().toISOString()]);
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
  if (typeof data.images === 'string') { try { data.images = JSON.parse(data.images); } catch(e) { data.images = []; } }
  return jsonResponse(data);
}
async function handleAdminUpdateAnnounce(env, body) {
  const { content, images } = body;
  await runDB(env, 'DELETE FROM announces');
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  await runDB(env, 'INSERT INTO announces (id, content, images, updated_at) VALUES (?, ?, ?, ?)', [generateId(), content || '欢迎使用 QW电竞护航平台！', imagesJson, new Date().toISOString()]);
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
//  管理员订单列表
// ============================================================
async function handleAdminGetOrders(env) {
  const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}
async function handleAdminCancelOrder(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
  // 只有商品购买订单（有 product_id）才退还红钻，派单订单不再扣钻所以也不退
  if (order && order.boss_id && order.product_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price, order.boss_id]);
  }
  return jsonResponse({ message: '已取消' });
}

// ============================================================
//  管理员充值
// ============================================================
async function handleAdminGetRecharges(env) {
  const result = await queryDB(env, `SELECT r.*, u.username FROM recharge_requests r LEFT JOIN users u ON r.user_id = u.id ORDER BY r.created_at DESC`);
  return jsonResponse(result.results || []);
}
async function handleAdminApproveRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "approved", handled_at = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  if (recharge.user_id) await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
  return jsonResponse({ success: true, message: '审核通过' });
}
async function handleAdminRejectRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "rejected", handled_at = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
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

/** 管理员扣除任意用户红钻 */
async function handleAdminDeductDiamond(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const admin = await getUserById(env, userId);
  if (!admin || admin.role !== 'admin') return errorResponse('权限不足', 403);
  const { targetUserId, amount, reason } = body;
  if (!targetUserId || !amount || amount < 1) return errorResponse('请填写用户和扣除数量');
  const target = await getUserById(env, targetUserId);
  if (!target) return errorResponse('用户不存在', 404);
  const current = Number(target.diamond) || 0;
  const deduct = Math.min(current, parseInt(amount));
  if (deduct <= 0) return errorResponse('该用户红钻余额为0');
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [deduct, targetUserId]);
  return jsonResponse({
    success: true,
    message: `已扣除 ${deduct} 红钻${reason ? '（' + reason + '）' : ''}`,
    deducted: deduct,
    remain: current - deduct
  });
}

// ============================================================
//  打手列表
// ============================================================
async function handleGetHandlers(env) {
  const result = await queryDB(env, 'SELECT id, username FROM users WHERE role = "handler" AND status = "active"');
  return jsonResponse(result.results || []);
}
async function handleHealthCheck(env) { return jsonResponse({ status: 'ok', time: new Date().toISOString() }); }

// ============================================================
//  B2 S3 上传（SigV4 签名，纯 JS，无依赖）
// ============================================================
async function sha256Hex(data) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hash = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(hash)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacSign(key, data) {
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    typeof key === 'string' ? new TextEncoder().encode(key) : key,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data)));
}

function toHex(buf) {
  return [...buf].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function signB2Request(env, method, objectKey, payloadHash) {
  const keyId = env.B2_KEY_ID;
  const appKey = env.B2_APP_KEY;
  const bucket = env.B2_BUCKET;
  const endpoint = env.B2_ENDPOINT;
  const region = env.B2_REGION;

  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.substring(0, 8);

  const host = endpoint;
  const canonicalUri = `/${bucket}/${objectKey}`;
  const service = 's3';

  const canonicalHeaders =
    `host:${host}\n` +
    `x-amz-content-sha256:${payloadHash}\n` +
    `x-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';

  const canonicalRequest =
    `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign =
    `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`;

  const kDate = await hmacSign(`AWS4${appKey}`, dateStamp);
  const kRegion = await hmacSign(kDate, region);
  const kService = await hmacSign(kRegion, service);
  const kSigning = await hmacSign(kService, 'aws4_request');
  const signature = toHex(await hmacSign(kSigning, stringToSign));

  const authorization =
    `AWS4-HMAC-SHA256 Credential=${keyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return {
    url: `https://${host}${canonicalUri}`,
    headers: {
      'Host': host,
      'Authorization': authorization,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate
    }
  };
}

async function handleUploadFile(env, authHeader, request) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);

  try {
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file) return errorResponse('未收到文件');

    const fileName = (file.name || 'file').replace(/[^a-zA-Z0-9._-]/g, '_');
    const contentType = file.type || 'application/octet-stream';
    const arrayBuffer = await file.arrayBuffer();

    if (arrayBuffer.byteLength > 95 * 1024 * 1024) {
      return errorResponse('文件过大，请上传小于 95MB');
    }

    const ext = fileName.includes('.') ? fileName.split('.').pop() : 'bin';
    const dateFolder = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const randomName = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const objectKey = `${dateFolder}/${randomName}.${ext}`;

    const payloadHash = await sha256Hex(arrayBuffer);
    const signed = await signB2Request(env, 'PUT', objectKey, payloadHash);

    const uploadRes = await fetch(signed.url, {
      method: 'PUT',
      headers: { ...signed.headers, 'Content-Type': contentType },
      body: arrayBuffer
    });

    if (!uploadRes.ok) {
      const errText = await uploadRes.text();
      console.error('B2 上传失败:', errText);
      return errorResponse('上传失败: HTTP ' + uploadRes.status, 500);
    }

    const proxyUrl = `/api/file/${objectKey}`;
    return jsonResponse({ success: true, url: proxyUrl, key: objectKey });
  } catch (err) {
    console.error('上传异常:', err);
    return errorResponse('上传失败: ' + err.message, 500);
  }
}

async function handleProxyFile(env, objectKey) {
  try {
    const emptyHash = await sha256Hex('');
    const signed = await signB2Request(env, 'GET', objectKey, emptyHash);

    const res = await fetch(signed.url, { method: 'GET', headers: signed.headers });
    if (!res.ok) return new Response('文件不存在', { status: 404 });

    const contentType = res.headers.get('Content-Type') || 'application/octet-stream';
    const contentLength = res.headers.get('Content-Length') || '';
    const headers = new Headers();
    headers.set('Content-Type', contentType);
    if (contentLength) headers.set('Content-Length', contentLength);
    headers.set('Cache-Control', 'public, max-age=31536000');
    headers.set('Access-Control-Allow-Origin', '*');

    return new Response(res.body, { status: 200, headers });
  } catch (err) {
    console.error('代理读取失败:', err);
    return new Response('读取失败', { status: 500 });
  }
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
  const contentType = request.headers.get('Content-Type') || '';
  if (method !== 'GET' && method !== 'OPTIONS' && contentType.includes('application/json')) {
    try {
      const text = await request.text();
      body = text ? JSON.parse(text) : {};
    } catch (e) { body = {}; }
  }

  if (method === 'OPTIONS') {
    return new Response(null, { headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' } });
  }
  try {
    const authHeader = request.headers.get('Authorization');

    if (path === '/api/health' && method === 'GET') return await handleHealthCheck(env);

    if (path.startsWith('/api/file/') && method === 'GET') {
      const key = path.replace('/api/file/', '');
      return await handleProxyFile(env, decodeURIComponent(key));
    }

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
    if (path === '/api/gifts' && method === 'GET') return await handleGetGifts(env);

    // 公开：店铺入驻打手列表、用户礼物
    if (path.startsWith('/api/shops/') && path.endsWith('/handlers') && method === 'GET') {
      const shopId = path.replace('/api/shops/', '').replace('/handlers', '');
      return await handleGetShopHandlers(env, shopId);
    }
    if (path.startsWith('/api/users/') && path.endsWith('/gifts') && method === 'GET') {
      const uId = path.replace('/api/users/', '').replace('/gifts', '');
      return await handleGetUserGifts(env, uId);
    }
    if (path.startsWith('/api/handlers/') && path.endsWith('/shops') && method === 'GET') {
      const handlerId = path.replace('/api/handlers/', '').replace('/shops', '');
      return await handleGetHandlerShops(env, handlerId);
    }

    if (path.startsWith('/api/users/') && method === 'GET') return await handleGetUserPublic(env, path.replace('/api/users/', ''));
    if (path.startsWith('/api/posts/') && method === 'GET') return await handleGetPostDetail(env, path.replace('/api/posts/', ''));
    if (path.startsWith('/api/shops/') && path.endsWith('/reviews') && method === 'GET') return await handleGetShopReviews(env, path.replace('/api/shops/', '').replace('/reviews', ''));
    if (path.startsWith('/api/shops/') && path.endsWith('/products') && method === 'GET') return await handleGetShopProducts(env, path.replace('/api/shops/', '').replace('/products', ''));
    if (path.startsWith('/api/shops/') && path.endsWith('/categories') && method === 'GET') return await handleGetShopCategories(env, path.replace('/api/shops/', '').replace('/categories', ''));
    if (path.startsWith('/api/shops/') && method === 'GET' && !path.endsWith('/products') && !path.endsWith('/categories') && !path.endsWith('/follow') && !path.endsWith('/follow-status') && !path.endsWith('/reviews') && !path.endsWith('/handlers')) {
      return await handleGetShopDetail(env, path.replace('/api/shops/', ''));
    }
    if (path.startsWith('/api/products/') && method === 'GET') return await handleGetProductDetail(env, path.replace('/api/products/', ''));

    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/upload' && method === 'POST') return await handleUploadFile(env, authHeader, request);
    if (path === '/api/user-id' && method === 'PUT') return await handleChangeUserId(env, authHeader, body);
    if (path === '/api/user/avatar' && method === 'POST') return await handleUploadAvatar(env, authHeader, body);
    if (path === '/api/user/name' && method === 'PUT') return await handleChangeName(env, authHeader, body);
    if (path === '/api/user/banner' && method === 'PUT') return await handleSetBanner(env, authHeader, body);
    if (path === '/api/user/toggle-accepting' && method === 'POST') return await handleToggleAccepting(env, authHeader);
    if (path === '/api/user/bio' && method === 'PUT') return await handleUpdateBio(env, authHeader, body);
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
    if (path === '/api/reviews' && method === 'POST') return await handleCreateReview(env, authHeader, body);
    if (path === '/api/messages/send' && method === 'POST') return await handleSendMessage(env, authHeader, body);
    if (path === '/api/messages/contacts' && method === 'GET') return await handleGetContacts(env, authHeader);
    if (path === '/api/messages/history' && method === 'POST') return await handleGetMessages(env, authHeader, body);
    if (path === '/api/messages/unread' && method === 'GET') return await handleGetUnreadCount(env, authHeader);
    if (path === '/api/gifts/send' && method === 'POST') return await handleSendGift(env, authHeader, body);
    if (path === '/api/heartbeat' && method === 'POST') return await handleHeartbeat(env, authHeader);
    if (path === '/api/auto-replies' && method === 'GET') return await handleGetAutoReplies(env, authHeader);
    if (path === '/api/auto-replies' && method === 'POST') return await handleSaveAutoReply(env, authHeader, body);
    if (path.startsWith('/api/auto-replies/') && method === 'DELETE') {
      return await handleDeleteAutoReply(env, authHeader, path.replace('/api/auto-replies/', ''));
    }
    if (path.startsWith('/api/handlers/') && path.endsWith('/reviews') && method === 'GET') {
      const hId = path.replace('/api/handlers/', '').replace('/reviews', '');
      return await handleGetHandlerReviews(env, hId);
    }

    if (path === '/api/handler/pending-orders' && method === 'GET') return await handleGetPendingOrders(env, authHeader);

    if (path === '/api/my-shop' && method === 'GET') return await handleMyShop(env, authHeader);
    if (path === '/api/my-shop/apply' && method === 'POST') return await handleApplyShop(env, authHeader, body);
    if (path === '/api/my-shop/products' && method === 'GET') return await handleGetMyShopProducts(env, authHeader);
    if (path === '/api/my-shop/orders' && method === 'GET') return await handleGetMyShopOrders(env, authHeader);
    if (path === '/api/my-shop/handlers' && method === 'GET') return await handleGetMyShopHandlers(env, authHeader);
    if (path === '/api/my-shop/update' && method === 'PUT') return await handleMyShopUpdate(env, authHeader, body);
    if (path === '/api/my-shop/invite' && method === 'POST') return await handleInviteHandler(env, authHeader, body);

    if (path === '/api/service/recharges' && method === 'GET') return await handleGetPendingRecharges(env, authHeader);
    if (path === '/api/service/process' && method === 'POST') return await handleProcessRecharge(env, authHeader, body);
    if (path === '/api/service/users' && method === 'GET') return await handleGetUsersForService(env, authHeader);
    if (path === '/api/service/gift' && method === 'POST') return await handleServiceGift(env, authHeader, body);

    if (path === '/api/shop-categories' && method === 'POST') return await handleCreateShopCategory(env, authHeader, body);
    if (path.startsWith('/api/shop-categories/')) {
      const catId = path.replace('/api/shop-categories/', '');
      if (method === 'PUT') return await handleUpdateShopCategory(env, authHeader, catId, body);
      if (method === 'DELETE') return await handleDeleteShopCategory(env, authHeader, catId);
    }

    if (path.startsWith('/api/shops/') && path.endsWith('/follow') && method === 'POST') {
      return await handleFollowShop(env, authHeader, path.replace('/api/shops/', '').replace('/follow', ''));
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/follow-status') && method === 'GET') {
      return await handleGetFollowStatus(env, authHeader, path.replace('/api/shops/', '').replace('/follow-status', ''));
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/join') && method === 'POST') {
      const shopId = path.replace('/api/shops/', '').replace('/join', '');
      return await handleJoinShop(env, authHeader, shopId);
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/leave') && method === 'POST') {
      const shopId = path.replace('/api/shops/', '').replace('/leave', '');
      return await handleLeaveShop(env, authHeader, shopId);
    }

    if (path.startsWith('/api/admin/orders/')) {
      const oId = path.replace('/api/admin/orders/', '');
      if (oId.endsWith('/confirm') && method === 'PUT') return await handleAdminConfirm(env, oId.replace('/confirm', ''));
      if (oId.endsWith('/force-complete') && method === 'PUT') return await handleAdminForceComplete(env, oId.replace('/force-complete', ''));
      if (oId.endsWith('/cancel') && method === 'PUT') return await handleAdminCancelOrder(env, oId.replace('/cancel', ''));
      if (method === 'DELETE') return await handleAdminDeleteOrder(env, oId);
    }

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

    if (path.startsWith('/api/posts/')) {
      const postId = path.replace('/api/posts/', '');
      if (postId.endsWith('/like') && method === 'POST') return await handleLikePost(env, authHeader, postId.replace('/like', ''));
      if (postId.endsWith('/comment') && method === 'POST') return await handleCommentPost(env, authHeader, postId.replace('/comment', ''), body);
      if (method === 'DELETE') return await handleDeletePost(env, authHeader, postId);
    }

    if (path.startsWith('/api/mails/') && path.endsWith('/claim') && method === 'PUT') {
      return await handleClaimMail(env, authHeader, path.replace('/api/mails/', '').replace('/claim', ''));
    }

    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        if (path === '/api/shops' && method === 'POST') return await handleCreateShop(env, authHeader, body);
        if (path.startsWith('/api/shops/')) {
          const shopId = path.replace('/api/shops/', '');
          if (shopId.endsWith('/toggle') && method === 'PUT') return await handleToggleShop(env, authHeader, shopId.replace('/toggle', ''));
          if (shopId.endsWith('/sort') && method === 'PUT') return await handleUpdateShopSort(env, authHeader, shopId.replace('/sort', ''), body);
          if (shopId.endsWith('/owner') && method === 'PUT') return await handleChangeShopOwner(env, authHeader, shopId.replace('/owner', ''), body);
          if (method === 'PUT') return await handleUpdateShop(env, authHeader, shopId, body);
          if (method === 'DELETE') return await handleDeleteShop(env, authHeader, shopId);
        }
        if (path === '/api/admin/shop-applications' && method === 'GET') return await handleGetAllShopApplications(env, authHeader);
        if (path.startsWith('/api/admin/shop-applications/')) {
          const appId = path.replace('/api/admin/shop-applications/', '');
          if (appId.endsWith('/approve') && method === 'PUT') return await handleApproveShopApplication(env, authHeader, appId.replace('/approve', ''));
          if (appId.endsWith('/reject') && method === 'PUT') return await handleRejectShopApplication(env, authHeader, appId.replace('/reject', ''), body);
        }
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminGetUsers(env);
        if (path === '/api/admin/user-id' && method === 'PUT') return await handleChangeUserId(env, authHeader, body);
        if (path === '/api/admin/gift' && method === 'POST') return await handleAdminGiftDiamond(env, body);
        if (path === '/api/admin/deduct' && method === 'POST') return await handleAdminDeductDiamond(env, authHeader, body);
        if (path.startsWith('/api/admin/users/')) {
          const tId = path.replace('/api/admin/users/', '');
          if (tId.endsWith('/ban') && method === 'PUT') return await handleAdminToggleBan(env, tId.replace('/ban', ''));
          if (tId.endsWith('/reset-password') && method === 'PUT') return await handleAdminResetPassword(env, tId.replace('/reset-password', ''));
          if (tId.endsWith('/approve') && method === 'PUT') return await handleApproveHandler(env, tId.replace('/approve', ''));
          if (tId.endsWith('/username') && method === 'PUT') return await handleChangeUsername(env, tId.replace('/username', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteUser(env, tId);
        }
        if (path === '/api/admin/products' && method === 'GET') return await handleAdminGetProducts(env);
        if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(env, body);
        if (path.startsWith('/api/admin/products/')) {
          const pId = path.replace('/api/admin/products/', '');
          if (pId.endsWith('/unshelf') && method === 'PUT') return await handleAdminUnshelf(env, pId.replace('/unshelf', ''));
          if (pId.endsWith('/reshelf') && method === 'PUT') return await handleAdminReshelf(env, pId.replace('/reshelf', ''));
          if (pId.endsWith('/edit') && method === 'PUT') return await handleAdminUpdateProduct(env, pId.replace('/edit', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteProduct(env, pId);
        }
        if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
        if (path.startsWith('/api/admin/categories/')) {
          const cId = path.replace('/api/admin/categories/', '');
          if (cId.endsWith('/edit') && method === 'PUT') return await handleAdminUpdateCategory(env, cId.replace('/edit', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteCategory(env, cId);
        }
        if (path === '/api/admin/post-categories' && method === 'POST') return await handleCreatePostCategory(env, authHeader, body);
        if (path.startsWith('/api/admin/post-categories/')) {
          const pcId = path.replace('/api/admin/post-categories/', '');
          if (method === 'PUT') return await handleUpdatePostCategory(env, authHeader, pcId, body);
          if (method === 'DELETE') return await handleDeletePostCategory(env, authHeader, pcId);
        }
        if (path === '/api/admin/recharge-images' && method === 'POST') return await handleAddRechargeImage(env, authHeader, body);
        if (path.startsWith('/api/admin/recharge-images/') && method === 'DELETE') {
          return await handleDeleteRechargeImage(env, authHeader, path.replace('/api/admin/recharge-images/', ''));
        }
        if (path === '/api/admin/banners' && method === 'POST') return await handleAdminCreateBanner(env, authHeader, body);
        if (path.startsWith('/api/admin/banners/') && method === 'DELETE') {
          return await handleAdminDeleteBanner(env, authHeader, path.replace('/api/admin/banners/', ''));
        }
        if (path === '/api/admin/icons' && method === 'POST') return await handleAdminSetIcon(env, authHeader, body);
        if (path.startsWith('/api/admin/icons/') && method === 'DELETE') {
          return await handleAdminDeleteIcon(env, authHeader, path.replace('/api/admin/icons/', ''));
        }
        if (path === '/api/admin/withdrawals' && method === 'GET') return await handleAdminGetWithdrawals(env, authHeader);
        if (path.startsWith('/api/admin/withdrawals/')) {
          const wId = path.replace('/api/admin/withdrawals/', '');
          if (wId.endsWith('/approve') && method === 'PUT') return await handleAdminApproveWithdraw(env, authHeader, wId.replace('/approve', ''));
          if (wId.endsWith('/reject') && method === 'PUT') return await handleAdminRejectWithdraw(env, authHeader, wId.replace('/reject', ''), body);
          if (method === 'DELETE') return await handleAdminDeleteWithdraw(env, authHeader, wId);
        }
        if (path === '/api/admin/orders' && method === 'GET') return await handleAdminGetOrders(env);
        if (path === '/api/admin/recharges' && method === 'GET') return await handleAdminGetRecharges(env);
        if (path.startsWith('/api/admin/recharges/')) {
          const rId = path.replace('/api/admin/recharges/', '');
          if (rId.endsWith('/approve') && method === 'PUT') return await handleAdminApproveRecharge(env, rId.replace('/approve', ''));
          if (rId.endsWith('/reject') && method === 'PUT') return await handleAdminRejectRecharge(env, rId.replace('/reject', ''));
          if (method === 'DELETE') return await handleAdminDeleteRecharge(env, rId);
        }
        if (path === '/api/admin/announce' && method === 'PUT') return await handleAdminUpdateAnnounce(env, body);
        if (path === '/api/admin/gifts' && method === 'POST') return await handleAdminCreateGift(env, authHeader, body);
        if (path.startsWith('/api/admin/gifts/') && method === 'DELETE') {
          const gId = path.replace('/api/admin/gifts/', '');
          return await handleAdminDeleteGift(env, authHeader, gId);
        }
      }
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}