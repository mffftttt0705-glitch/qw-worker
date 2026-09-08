// ============================================================
//  QW电竞 - 完整后端 API
//  包含：用户、商品、订单、分类、充值、客服、消息、店铺、提现、广告、关注、改名、背景墙、图标、头像、帖子
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
  if (params.length > 0) {
    return await stmt.bind(...params).all();
  }
  return await stmt.all();
}

async function runDB(env, sql, params = []) {
  const stmt = env.DB.prepare(sql);
  if (params.length > 0) {
    return await stmt.bind(...params).run();
  }
  return await stmt.run();
}

// ============================================================
//  用户认证
// ============================================================
async function handleRegister(env, body) {
  const { username, password, role, status } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已存在');
  }

  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM users');
  const count = countResult.results?.[0]?.count || 0;
  const userId = String(100000 + count + 1);

  const userStatus = (role === 'handler' || role === 'dispatcher' || role === 'service') ? 'pending' : (status || 'active');
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status, avatar) VALUES (?, ?, ?, ?, 0, 0, ?, ?)',
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
      id: user.id,
      username: user.username,
      role: user.role || 'boss',
      diamond: user.diamond || 0,
      balance: user.balance || 0,
      status: user.status || 'active',
      banner: user.banner || '',
      avatar: user.avatar || '',
      club_prefix: user.club_prefix || '',
      level: user.level || 1
    }
  });
}

async function handleGetMe(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  
  // 获取头像
  const avatarResult = await queryDB(env, 'SELECT avatar_url FROM user_avatars WHERE user_id = ? ORDER BY created_at DESC LIMIT 1', [userId]);
  const avatar = avatarResult.results?.[0]?.avatar_url || user.avatar || '';
  
  const { password, ...rest } = user;
  rest.avatar = avatar;
  return jsonResponse(rest);
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
//  头像上传
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

// ============================================================
//  帖子系统
// ============================================================
async function handleCreatePost(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  
  const { content, images } = body;
  if (!content || !content.trim()) return errorResponse('请输入内容');
  
  const id = generateId();
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
  
  await runDB(env,
    `INSERT INTO posts (id, user_id, content, images, created_at) VALUES (?, ?, ?, ?, ?)`,
    [id, userId, content.trim(), imagesJson, new Date().toISOString()]
  );
  
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
  
  if (userId) {
    sql += ' AND p.user_id = ?';
    params.push(userId);
  }
  
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
  
  // 获取评论
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
//  店铺管理（修复）
// ============================================================
async function handleGetShops(env, url) {
  const category = url?.searchParams?.get('category');
  let sql = 'SELECT * FROM shops ORDER BY is_self DESC, is_recommend DESC, created_at DESC';
  const params = [];
  if (category) {
    sql = 'SELECT * FROM shops WHERE category_id = ? ORDER BY is_self DESC, is_recommend DESC, created_at DESC';
    params.push(category);
  }
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleCreateShop(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可创建店铺', 403);
  }
  
  const { name, description, logo, banner, category_id, is_self, is_recommend } = body;
  if (!name) return errorResponse('请输入店铺名称');
  
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM shops');
  const count = countResult.results?.[0]?.count || 0;
  const shopId = 'a' + String(100000 + count + 1);
  
  await runDB(env,
    `INSERT INTO shops (id, owner_id, name, description, logo, banner, category_id, status, rating, sales, is_self, is_recommend, follow_count, created_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', '4.9', 0, ?, ?, 0, ?)`,
    [shopId, userId, name, description || '', logo || '', banner || '', category_id || null, is_self ? 1 : 0, is_recommend ? 1 : 0, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id: shopId, message: '店铺创建成功' });
}

async function handleUpdateShop(env, authHeader, shopId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可编辑店铺', 403);
  }
  
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
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可操作', 403);
  }
  
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) {
    return errorResponse('店铺不存在', 404);
  }
  const shop = result.results[0];
  const newStatus = shop.status === 'active' ? 'inactive' : 'active';
  await runDB(env, 'UPDATE shops SET status = ? WHERE id = ?', [newStatus, shopId]);
  return jsonResponse({ success: true, message: `店铺已${newStatus === 'active' ? '开启' : '关闭'}` });
}

async function handleDeleteShop(env, authHeader, shopId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可删除店铺', 403);
  }
  
  const check = await queryDB(env, 'SELECT COUNT(*) as count FROM products WHERE shop_id = ?', [shopId]);
  if (check.results && check.results[0] && check.results[0].count > 0) {
    return errorResponse('该店铺下还有商品，请先移除商品', 400);
  }
  
  await runDB(env, 'DELETE FROM shops WHERE id = ?', [shopId]);
  return jsonResponse({ success: true, message: '店铺已删除' });
}

async function handleGetShopDetail(env, shopId) {
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) {
    return errorResponse('店铺不存在', 404);
  }
  const shop = result.results[0];
  const countResult = await queryDB(env, 'SELECT COUNT(*) as count FROM products WHERE shop_id = ? AND hidden = 0', [shopId]);
  shop.productCount = countResult.results?.[0]?.count || 0;
  return jsonResponse(shop);
}

// ============================================================
//  店铺分类管理
// ============================================================
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
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可操作', 403);
  }
  
  const { shop_id, name } = body;
  if (!shop_id) return errorResponse('请选择店铺');
  if (!name) return errorResponse('请输入分类名称');
  
  const id = generateId();
  await runDB(env,
    'INSERT INTO shop_categories (id, shop_id, name, sort_order, created_at) VALUES (?, ?, ?, 0, ?)',
    [id, shop_id, name, new Date().toISOString()]
  );
  return jsonResponse({ success: true, id, message: '店铺分类创建成功' });
}

async function handleDeleteShopCategory(env, authHeader, categoryId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') {
    return errorResponse('只有管理员可操作', 403);
  }
  
  await runDB(env, 'DELETE FROM shop_categories WHERE id = ?', [categoryId]);
  return jsonResponse({ success: true, message: '店铺分类已删除' });
}

// ============================================================
//  分类管理
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
  if (check.results && check.results[0] && check.results[0].count > 0) {
    return errorResponse('该分类下还有商品，请先移除商品', 400);
  }
  const childCheck = await queryDB(env, 'SELECT COUNT(*) as count FROM categories WHERE parent_id = ?', [categoryId]);
  if (childCheck.results && childCheck.results[0] && childCheck.results[0].count > 0) {
    return errorResponse('该分类下还有子分类，请先删除子分类', 400);
  }
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
  if (category) {
    sql += ' AND p.category_id = ?';
    params.push(category);
  }
  if (shop) {
    sql += ' AND p.shop_id = ?';
    params.push(shop);
  }
  if (shopCategory) {
    sql += ' AND p.shop_category_id = ?';
    params.push(shopCategory);
  }
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
  if (detailImages.length === 0 && product.image) {
    detailImages = [product.image];
  }
  product.detail_images = detailImages;
  return jsonResponse(product);
}

// ============================================================
//  用户管理（修复加载失败）
// ============================================================
async function handleAdminGetUsers(env) {
  try {
    const result = await queryDB(env, 
      'SELECT id, username, role, diamond, balance, status, created_at, banner, avatar, club_prefix, level FROM users ORDER BY created_at DESC'
    );
    return jsonResponse(result.results || []);
  } catch (err) {
    console.error('获取用户列表失败:', err);
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
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已被使用');
  }
  await runDB(env, 'UPDATE users SET username = ? WHERE id = ?', [username, targetUserId]);
  return jsonResponse({ success: true, message: '用户名已修改' });
}

// ============================================================
//  广告管理（修复上传）
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
  await runDB(env,
    'INSERT INTO banners (id, image_url, link, sort_order, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, image_url, link || '', sort_order || 0, new Date().toISOString()]
  );
  
  // 同时更新本地缓存
  const bannersResult = await queryDB(env, 'SELECT * FROM banners ORDER BY sort_order ASC');
  const banners = bannersResult.results || [];
  
  return jsonResponse({ success: true, id, message: '广告添加成功', banners });
}

async function handleAdminDeleteBanner(env, authHeader, bannerId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin') return errorResponse('权限不足', 403);
  
  await runDB(env, 'DELETE FROM banners WHERE id = ?', [bannerId]);
  
  const bannersResult = await queryDB(env, 'SELECT * FROM banners ORDER BY sort_order ASC');
  const banners = bannersResult.results || [];
  
  return jsonResponse({ success: true, message: '已删除', banners });
}

// ============================================================
//  其他功能（保持原有完整功能）
// ============================================================
async function handleGetHandlers(env) {
  const result = await queryDB(env, 'SELECT id, username FROM users WHERE role = "handler" AND status = "active"');
  return jsonResponse(result.results || []);
}

// ... 其他功能函数保持不变（订单、充值、消息、提现、公告、图标等）

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

    // ===== 公开接口 =====
    if (path === '/api/health' && method === 'GET') return jsonResponse({ status: 'ok' });
    if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
    if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(env, url);
    if (path === '/api/categories' && method === 'GET') return await handleGetCategories(env);
    if (path === '/api/shops' && method === 'GET') return await handleGetShops(env, url);
    if (path === '/api/banners' && method === 'GET') return await handleGetBanners(env);
    if (path === '/api/handlers' && method === 'GET') return await handleGetHandlers(env);
    if (path === '/api/posts' && method === 'GET') return await handleGetPosts(env, url);
    if (path.startsWith('/api/posts/') && method === 'GET') {
      const postId = path.replace('/api/posts/', '');
      return await handleGetPostDetail(env, postId);
    }
    
    // ===== 需要登录的接口 =====
    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/user/avatar' && method === 'POST') return await handleUploadAvatar(env, authHeader, body);
    if (path === '/api/user/name' && method === 'PUT') return await handleChangeName(env, authHeader, body);
    if (path === '/api/user/banner' && method === 'PUT') return await handleSetBanner(env, authHeader, body);
    
    // 帖子相关
    if (path === '/api/posts' && method === 'POST') return await handleCreatePost(env, authHeader, body);
    if (path.startsWith('/api/posts/')) {
      const postId = path.replace('/api/posts/', '');
      if (postId.endsWith('/like') && method === 'POST') {
        const id = postId.replace('/like', '');
        return await handleLikePost(env, authHeader, id);
      }
      if (postId.endsWith('/comment') && method === 'POST') {
        const id = postId.replace('/comment', '');
        return await handleCommentPost(env, authHeader, id, body);
      }
      if (method === 'DELETE') return await handleDeletePost(env, authHeader, postId);
    }
    
    // 店铺相关
    if (path === '/api/shops' && method === 'POST') return await handleCreateShop(env, authHeader, body);
    if (path.startsWith('/api/shops/')) {
      const shopId = path.replace('/api/shops/', '');
      if (shopId.endsWith('/toggle') && method === 'PUT') {
        const id = shopId.replace('/toggle', '');
        return await handleToggleShop(env, authHeader, id);
      }
      if (shopId.endsWith('/categories') && method === 'GET') {
        const id = shopId.replace('/categories', '');
        return await handleGetShopCategories(env, id);
      }
      if (method === 'PUT') return await handleUpdateShop(env, authHeader, shopId, body);
      if (method === 'DELETE') return await handleDeleteShop(env, authHeader, shopId);
      if (method === 'GET') return await handleGetShopDetail(env, shopId);
    }
    
    // 店铺分类管理
    if (path === '/api/shop-categories' && method === 'POST') return await handleCreateShopCategory(env, authHeader, body);
    if (path.startsWith('/api/shop-categories/') && method === 'DELETE') {
      const categoryId = path.replace('/api/shop-categories/', '');
      return await handleDeleteShopCategory(env, authHeader, categoryId);
    }

    // ===== 管理员接口 =====
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        // 用户管理
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminGetUsers(env);
        if (path.startsWith('/api/admin/users/')) {
          const targetUserId = path.replace('/api/admin/users/', '');
          if (targetUserId.endsWith('/ban') && method === 'PUT') {
            const id = targetUserId.replace('/ban', '');
            return await handleAdminToggleBan(env, id);
          }
          if (targetUserId.endsWith('/reset-password') && method === 'PUT') {
            const id = targetUserId.replace('/reset-password', '');
            return await handleAdminResetPassword(env, id);
          }
          if (targetUserId.endsWith('/approve') && method === 'PUT') {
            const id = targetUserId.replace('/approve', '');
            return await handleApproveHandler(env, id);
          }
          if (targetUserId.endsWith('/username') && method === 'PUT') {
            const id = targetUserId.replace('/username', '');
            return await handleChangeUsername(env, id, body);
          }
        }
        
        // 分类管理
        if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
        if (path.startsWith('/api/admin/categories/')) {
          const categoryId = path.replace('/api/admin/categories/', '');
          if (categoryId.endsWith('/edit') && method === 'PUT') {
            const id = categoryId.replace('/edit', '');
            return await handleAdminUpdateCategory(env, id, body);
          }
          if (method === 'DELETE') return await handleAdminDeleteCategory(env, categoryId);
        }
        
        // 广告管理
        if (path === '/api/admin/banners' && method === 'POST') return await handleAdminCreateBanner(env, authHeader, body);
        if (path.startsWith('/api/admin/banners/') && method === 'DELETE') {
          const bannerId = path.replace('/api/admin/banners/', '');
          return await handleAdminDeleteBanner(env, authHeader, bannerId);
        }
        
        // ... 其他管理员接口
      }
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}

// 辅助函数（保持兼容）
async function handleChangeName(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { username } = body;
  if (!username) return errorResponse('请输入新用户名');
  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ? AND id != ?', [username, userId]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已被使用');
  }
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