// ============================================================
//  QW电竞 - 完整后端 API（修复版）
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
  try {
    const stmt = env.DB.prepare(sql);
    if (params.length > 0) {
      return await stmt.bind(...params).all();
    }
    return await stmt.all();
  } catch (err) {
    console.error('数据库查询失败:', err);
    return { results: [] };
  }
}

async function runDB(env, sql, params = []) {
  try {
    const stmt = env.DB.prepare(sql);
    if (params.length > 0) {
      return await stmt.bind(...params).run();
    }
    return await stmt.run();
  } catch (err) {
    console.error('数据库执行失败:', err);
    throw err;
  }
}

// ============================================================
//  初始化数据库表（自动创建）
// ============================================================
async function initDatabase(env) {
  try {
    // 检查表是否存在
    const tables = await queryDB(env, "SELECT name FROM sqlite_master WHERE type='table'");
    const existingTables = (tables.results || []).map(t => t.name);
    
    // 创建用户表
    if (!existingTables.includes('users')) {
      await runDB(env, `
        CREATE TABLE users (
          id TEXT PRIMARY KEY,
          username TEXT UNIQUE NOT NULL,
          password TEXT NOT NULL,
          role TEXT DEFAULT 'boss',
          diamond INTEGER DEFAULT 0,
          balance INTEGER DEFAULT 0,
          status TEXT DEFAULT 'active',
          banner TEXT,
          avatar TEXT,
          club_prefix TEXT,
          level INTEGER DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建分类表
    if (!existingTables.includes('categories')) {
      await runDB(env, `
        CREATE TABLE categories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          image TEXT,
          sort_order INTEGER DEFAULT 0,
          parent_id TEXT,
          created_at TEXT NOT NULL
        )
      `);
      // 插入默认分类
      await runDB(env, "INSERT OR IGNORE INTO categories (id, name, sort_order, created_at) VALUES ('cat1', '暗区突围', 1, datetime('now'))");
      await runDB(env, "INSERT OR IGNORE INTO categories (id, name, parent_id, sort_order, created_at) VALUES ('cat1_sub1', '排位护航', 'cat1', 1, datetime('now'))");
      await runDB(env, "INSERT OR IGNORE INTO categories (id, name, parent_id, sort_order, created_at) VALUES ('cat1_sub2', '安全箱', 'cat1', 2, datetime('now'))");
    }
    
    // 创建店铺表
    if (!existingTables.includes('shops')) {
      await runDB(env, `
        CREATE TABLE shops (
          id TEXT PRIMARY KEY,
          owner_id TEXT NOT NULL,
          name TEXT NOT NULL,
          description TEXT,
          logo TEXT,
          banner TEXT,
          category_id TEXT,
          status TEXT DEFAULT 'active',
          rating TEXT DEFAULT '4.9',
          sales INTEGER DEFAULT 0,
          is_self INTEGER DEFAULT 0,
          is_recommend INTEGER DEFAULT 0,
          follow_count INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
      // 插入默认店铺
      await runDB(env, "INSERT OR IGNORE INTO shops (id, owner_id, name, description, category_id, created_at) VALUES ('a100001', '100001', 'QW电竞俱乐部', '专业护航服务', 'cat1', datetime('now'))");
      await runDB(env, "INSERT OR IGNORE INTO shops (id, owner_id, name, description, category_id, created_at) VALUES ('a100002', '100001', '暗区突击队', '暗区突围专业团队', 'cat1', datetime('now'))");
    }
    
    // 创建商品表
    if (!existingTables.includes('products')) {
      await runDB(env, `
        CREATE TABLE products (
          id TEXT PRIMARY KEY,
          game TEXT,
          title TEXT NOT NULL,
          description TEXT,
          price REAL NOT NULL,
          quantity INTEGER DEFAULT 1,
          sold INTEGER DEFAULT 0,
          hidden INTEGER DEFAULT 0,
          image TEXT,
          detail_images TEXT,
          detail_desc TEXT,
          category_id TEXT,
          shop_id TEXT,
          shop_category_id TEXT,
          created_by TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
      // 插入默认商品
      await runDB(env, "INSERT OR IGNORE INTO products (id, title, description, price, quantity, category_id, shop_id) VALUES ('p1', '暗区突围排位护航', '专业打手护航，安全高效', 288, 10, 'cat1_sub1', 'a100001')");
      await runDB(env, "INSERT OR IGNORE INTO products (id, title, description, price, quantity, category_id, shop_id) VALUES ('p2', '暗区突围安全箱', '装备安全箱，保护你的装备', 188, 20, 'cat1_sub2', 'a100001')");
      await runDB(env, "INSERT OR IGNORE INTO products (id, title, description, price, quantity, category_id, shop_id) VALUES ('p3', '暗区突围快速护航', '1小时快速护航', 388, 5, 'cat1_sub1', 'a100002')");
    }
    
    // 创建店铺分类表
    if (!existingTables.includes('shop_categories')) {
      await runDB(env, `
        CREATE TABLE shop_categories (
          id TEXT PRIMARY KEY,
          shop_id TEXT NOT NULL,
          name TEXT NOT NULL,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT NOT NULL
        )
      `);
    }
    
    // 创建订单表
    if (!existingTables.includes('orders')) {
      await runDB(env, `
        CREATE TABLE orders (
          id TEXT PRIMARY KEY,
          product_id TEXT,
          boss_id TEXT NOT NULL,
          handler_id TEXT,
          status TEXT DEFAULT 'pending',
          price REAL NOT NULL,
          game TEXT,
          title TEXT NOT NULL,
          description TEXT,
          messages TEXT,
          start_time TEXT,
          end_time TEXT,
          settled INTEGER DEFAULT 0,
          settled_amount REAL,
          refund_reason TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建消息表
    if (!existingTables.includes('messages')) {
      await runDB(env, `
        CREATE TABLE messages (
          id TEXT PRIMARY KEY,
          sender_id TEXT NOT NULL,
          receiver_id TEXT NOT NULL,
          content TEXT NOT NULL,
          is_read INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建消息联系人表
    if (!existingTables.includes('message_contacts')) {
      await runDB(env, `
        CREATE TABLE message_contacts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          contact_id TEXT NOT NULL,
          last_message TEXT,
          last_time TEXT,
          unread_count INTEGER DEFAULT 0
        )
      `);
    }
    
    // 创建充值申请表
    if (!existingTables.includes('recharge_requests')) {
      await runDB(env, `
        CREATE TABLE recharge_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          amount REAL NOT NULL,
          diamond INTEGER NOT NULL,
          status TEXT DEFAULT 'pending',
          handler_id TEXT,
          reject_reason TEXT,
          handled_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建提现申请表
    if (!existingTables.includes('withdraw_requests')) {
      await runDB(env, `
        CREATE TABLE withdraw_requests (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          amount INTEGER NOT NULL,
          status TEXT DEFAULT 'pending',
          reject_reason TEXT,
          handled_at TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建公告表
    if (!existingTables.includes('announces')) {
      await runDB(env, `
        CREATE TABLE announces (
          id TEXT PRIMARY KEY,
          content TEXT,
          images TEXT,
          updated_at TEXT
        )
      `);
      await runDB(env, "INSERT OR IGNORE INTO announces (id, content, images, updated_at) VALUES ('ann1', '欢迎使用 QW电竞护航平台！', '[]', datetime('now'))");
    }
    
    // 创建广告表
    if (!existingTables.includes('banners')) {
      await runDB(env, `
        CREATE TABLE banners (
          id TEXT PRIMARY KEY,
          image_url TEXT NOT NULL,
          link TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建自定义图标表
    if (!existingTables.includes('custom_icons')) {
      await runDB(env, `
        CREATE TABLE custom_icons (
          id TEXT PRIMARY KEY,
          key TEXT UNIQUE NOT NULL,
          image_url TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建帖子表
    if (!existingTables.includes('posts')) {
      await runDB(env, `
        CREATE TABLE posts (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT,
          content TEXT,
          image TEXT,
          images TEXT,
          views INTEGER DEFAULT 0,
          likes INTEGER DEFAULT 0,
          comments_count INTEGER DEFAULT 0,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建评论表
    if (!existingTables.includes('comments')) {
      await runDB(env, `
        CREATE TABLE comments (
          id TEXT PRIMARY KEY,
          post_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          content TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    // 创建帖子点赞表
    if (!existingTables.includes('post_likes')) {
      await runDB(env, `
        CREATE TABLE post_likes (
          id TEXT PRIMARY KEY,
          post_id TEXT NOT NULL,
          user_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(post_id, user_id)
        )
      `);
    }
    
    // 创建店铺关注表
    if (!existingTables.includes('shop_follows')) {
      await runDB(env, `
        CREATE TABLE shop_follows (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          shop_id TEXT NOT NULL,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE(user_id, shop_id)
        )
      `);
    }
    
    // 创建邮件表
    if (!existingTables.includes('mails')) {
      await runDB(env, `
        CREATE TABLE mails (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          title TEXT NOT NULL,
          content TEXT,
          diamond INTEGER DEFAULT 0,
          status TEXT DEFAULT 'unread',
          claim_time TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
      `);
    }
    
    return true;
  } catch (err) {
    console.error('数据库初始化失败:', err);
    return false;
  }
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
  const { password, ...rest } = user;
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
//  用户头像/改名/背景墙
// ============================================================
async function handleSetAvatar(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { avatar } = body;
  if (!avatar) return errorResponse('请提供头像URL');
  await runDB(env, 'UPDATE users SET avatar = ? WHERE id = ?', [avatar, userId]);
  return jsonResponse({ success: true, message: '头像已更新' });
}

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
  await runDB(env, 'DELETE FROM categories WHERE id = ?', [categoryId]);
  return jsonResponse({ success: true, message: '分类已删除' });
}

// ============================================================
//  商品管理
// ============================================================
async function handleGetProducts(env, url) {
  const category = url?.searchParams?.get('category');
  const shop = url?.searchParams?.get('shop');
  let sql = `SELECT p.*, c.name as category_name, s.name as shop_name
             FROM products p 
             LEFT JOIN categories c ON p.category_id = c.id 
             LEFT JOIN shops s ON p.shop_id = s.id
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
  sql += ' ORDER BY p.created_at DESC';
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetProductDetail(env, productId) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name, s.name as shop_name
     FROM products p 
     LEFT JOIN categories c ON p.category_id = c.id 
     LEFT JOIN shops s ON p.shop_id = s.id
     WHERE p.id = ?`,
    [productId]
  );
  const product = (result.results && result.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  return jsonResponse(product);
}

async function handleAdminGetProducts(env) {
  const result = await queryDB(env,
    `SELECT p.*, c.name as category_name, s.name as shop_name
     FROM products p 
     LEFT JOIN categories c ON p.category_id = c.id 
     LEFT JOIN shops s ON p.shop_id = s.id
     ORDER BY p.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminCreateProduct(env, body) {
  const { game, title, desc, price, quantity, image, category_id, shop_id, shop_category_id } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  if (!category_id) return errorResponse('请选择系统分类');
  if (!shop_id) return errorResponse('请选择店铺');
  const id = generateId();
  await runDB(env,
    `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, category_id, shop_id, shop_category_id) 
     VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', category_id, shop_id, shop_category_id || null]
  );
  return jsonResponse({ success: true, id });
}

async function handleAdminUpdateProduct(env, productId, body) {
  const { game, title, desc, price, quantity, image, category_id, shop_id, shop_category_id } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  await runDB(env,
    `UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, category_id = ?, shop_id = ?, shop_category_id = ? WHERE id = ?`,
    [game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', category_id || null, shop_id || null, shop_category_id || null, productId]
  );
  return jsonResponse({ success: true, message: '商品已更新' });
}

async function handleAdminUnshelf(env, productId) {
  await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
  return jsonResponse({ success: true, message: '已下架' });
}

async function handleAdminReshelf(env, productId) {
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
  let sql = 'SELECT * FROM shops ORDER BY is_self DESC, is_recommend DESC, created_at DESC';
  const params = [];
  if (category) {
    sql = 'SELECT * FROM shops WHERE category_id = ? ORDER BY is_self DESC, is_recommend DESC, created_at DESC';
    params.push(category);
  }
  const result = await queryDB(env, sql, params);
  return jsonResponse(result.results || []);
}

async function handleGetShopDetail(env, shopId) {
  const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
  if (!result.results || result.results.length === 0) {
    return errorResponse('店铺不存在', 404);
  }
  return jsonResponse(result.results[0]);
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
  
  await runDB(env, 'DELETE FROM shops WHERE id = ?', [shopId]);
  return jsonResponse({ success: true, message: '店铺已删除' });
}

async function handleGetShopCategories(env, shopId) {
  const result = await queryDB(env,
    'SELECT * FROM shop_categories WHERE shop_id = ? ORDER BY sort_order ASC',
    [shopId]
  );
  return jsonResponse(result.results || []);
}

async function handleCreateShopCategory(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
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
    [orderId, productId, userId, product.price, product.game, product.title, product.description || '', 
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
  if (user.role === 'boss' || user.role === 'service' || user.role === 'admin') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else if (user.role === 'handler') {
    const pendingResult = await queryDB(env, 'SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC');
    const myResult = await queryDB(env, 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC', [userId]);
    const all = [...(pendingResult.results || []), ...(myResult.results || [])];
    const seen = new Set();
    const unique = all.filter(o => { const key = o.id; if (seen.has(key)) return false; seen.add(key); return true; });
    return jsonResponse(unique);
  } else {
    return jsonResponse([]);
  }
  const result = await queryDB(env, sql, [userId]);
  return jsonResponse(result.results || []);
}

async function handleGetOrderDetail(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  return jsonResponse(order);
}

async function handleTakeOrder(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可接单');
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
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status !== 'review') return errorResponse('只有待验收可确认');
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成' });
}

async function handleRefundRequest(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { reason } = body;
  if (!reason) return errorResponse('请填写退款原因');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.status === 'completed') return errorResponse('已完成订单不可退款');
  await runDB(env, 'UPDATE orders SET status = "refund_pending", refund_reason = ? WHERE id = ?', [reason, orderId]);
  return jsonResponse({ success: true, message: '退款申请已提交' });
}

// ============================================================
//  消息系统
// ============================================================
async function handleSendMessage(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
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
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 0)',
      [generateId(), userId, receiverId, content.trim(), new Date().toISOString()]
    );
  } else {
    await runDB(env,
      'UPDATE message_contacts SET last_message = ?, last_time = ? WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), userId, receiverId]
    );
  }
  
  const c2 = await queryDB(env, 'SELECT * FROM message_contacts WHERE user_id = ? AND contact_id = ?', [receiverId, userId]);
  if (!c2.results || c2.results.length === 0) {
    await runDB(env,
      'INSERT INTO message_contacts (id, user_id, contact_id, last_message, last_time, unread_count) VALUES (?, ?, ?, ?, ?, 1)',
      [generateId(), receiverId, userId, content.trim(), new Date().toISOString()]
    );
  } else {
    await runDB(env,
      'UPDATE message_contacts SET last_message = ?, last_time = ?, unread_count = unread_count + 1 WHERE user_id = ? AND contact_id = ?',
      [content.trim(), new Date().toISOString(), receiverId, userId]
    );
  }
  
  return jsonResponse({ success: true, message: '发送成功' });
}

async function handleGetContacts(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  
  const sql = `
    WITH all_contacts AS (
      SELECT DISTINCT sender_id as contact_id FROM messages WHERE receiver_id = ?
      UNION
      SELECT DISTINCT receiver_id as contact_id FROM messages WHERE sender_id = ?
    )
    SELECT 
      u.id, u.username, u.role, u.avatar,
      mc.last_message, mc.last_time, mc.unread_count
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
  const { contactId } = body;
  if (!contactId) return errorResponse('请选择联系人');
  
  const result = await queryDB(env,
    `SELECT m.*, u.username, u.avatar 
     FROM messages m
     LEFT JOIN users u ON u.id = m.sender_id
     WHERE (m.sender_id = ? AND m.receiver_id = ?) 
     OR (m.sender_id = ? AND m.receiver_id = ?)
     ORDER BY m.created_at ASC`,
    [userId, contactId, contactId, userId]
  );
  
  await runDB(env,
    'UPDATE messages SET is_read = 1 WHERE sender_id = ? AND receiver_id = ?',
    [contactId, userId]
  );
  await runDB(env,
    'UPDATE message_contacts SET unread_count = 0 WHERE user_id = ? AND contact_id = ?',
    [userId, contactId]
  );
  
  return jsonResponse(result.results || []);
}

async function handleGetUnreadCount(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const result = await queryDB(env,
    'SELECT SUM(unread_count) as total FROM message_contacts WHERE user_id = ?',
    [userId]
  );
  const total = (result.results && result.results[0] && result.results[0].total) || 0;
  return jsonResponse({ unread: total });
}

async function handleGetSupportContacts(env) {
  const result = await queryDB(env, 
    'SELECT id, username, avatar, role FROM users WHERE role IN ("admin", "service") AND status = "active"'
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  帖子系统
// ============================================================
async function handleGetPosts(env, url) {
  const limit = parseInt(url?.searchParams?.get('limit')) || 20;
  const offset = parseInt(url?.searchParams?.get('offset')) || 0;
  const result = await queryDB(env,
    `SELECT p.*, u.username, u.avatar 
     FROM posts p 
     LEFT JOIN users u ON p.user_id = u.id 
     ORDER BY p.created_at DESC 
     LIMIT ? OFFSET ?`,
    [limit, offset]
  );
  return jsonResponse(result.results || []);
}

async function handleGetPostDetail(env, postId) {
  const postResult = await queryDB(env,
    `SELECT p.*, u.username, u.avatar 
     FROM posts p 
     LEFT JOIN users u ON p.user_id = u.id 
     WHERE p.id = ?`,
    [postId]
  );
  const post = (postResult.results && postResult.results[0]) || null;
  if (!post) return errorResponse('帖子不存在', 404);
  
  await runDB(env, 'UPDATE posts SET views = views + 1 WHERE id = ?', [postId]);
  
  const commentsResult = await queryDB(env,
    `SELECT c.*, u.username, u.avatar 
     FROM comments c 
     LEFT JOIN users u ON c.user_id = u.id 
     WHERE c.post_id = ? 
     ORDER BY c.created_at ASC`,
    [postId]
  );
  post.comments = commentsResult.results || [];
  return jsonResponse(post);
}

async function handleCreatePost(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { title, content, image, images } = body;
  if (!title && !content) return errorResponse('请填写标题或内容');
  
  const id = generateId();
  const now = new Date().toISOString();
  const imagesJson = Array.isArray(images) ? JSON.stringify(images) : (images || '[]');
  
  await runDB(env,
    `INSERT INTO posts (id, user_id, title, content, image, images, created_at, updated_at) 
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, userId, title || '', content || '', image || '', imagesJson, now, now]
  );
  return jsonResponse({ success: true, id, message: '帖子发布成功' });
}

async function handleDeletePost(env, authHeader, postId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  const postResult = await queryDB(env, 'SELECT * FROM posts WHERE id = ?', [postId]);
  const post = (postResult.results && postResult.results[0]) || null;
  if (!post) return errorResponse('帖子不存在', 404);
  if (post.user_id !== userId && user.role !== 'admin') {
    return errorResponse('无权删除', 403);
  }
  await runDB(env, 'DELETE FROM posts WHERE id = ?', [postId]);
  await runDB(env, 'DELETE FROM comments WHERE post_id = ?', [postId]);
  await runDB(env, 'DELETE FROM post_likes WHERE post_id = ?', [postId]);
  return jsonResponse({ success: true, message: '帖子已删除' });
}

async function handleLikePost(env, authHeader, postId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  
  const existing = await queryDB(env, 'SELECT * FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
  if (existing.results && existing.results.length > 0) {
    await runDB(env, 'DELETE FROM post_likes WHERE post_id = ? AND user_id = ?', [postId, userId]);
    await runDB(env, 'UPDATE posts SET likes = likes - 1 WHERE id = ?', [postId]);
    return jsonResponse({ success: true, liked: false });
  } else {
    await runDB(env,
      'INSERT INTO post_likes (id, post_id, user_id, created_at) VALUES (?, ?, ?, ?)',
      [generateId(), postId, userId, new Date().toISOString()]
    );
    await runDB(env, 'UPDATE posts SET likes = likes + 1 WHERE id = ?', [postId]);
    return jsonResponse({ success: true, liked: true });
  }
}

async function handleCreateComment(env, authHeader, postId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { content } = body;
  if (!content || !content.trim()) return errorResponse('请输入评论内容');
  
  const id = generateId();
  await runDB(env,
    'INSERT INTO comments (id, post_id, user_id, content, created_at) VALUES (?, ?, ?, ?, ?)',
    [id, postId, userId, content.trim(), new Date().toISOString()]
  );
  await runDB(env, 'UPDATE posts SET comments_count = comments_count + 1 WHERE id = ?', [postId]);
  return jsonResponse({ success: true, id, message: '评论成功' });
}

async function handleDeleteComment(env, authHeader, commentId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  const commentResult = await queryDB(env, 'SELECT * FROM comments WHERE id = ?', [commentId]);
  const comment = (commentResult.results && commentResult.results[0]) || null;
  if (!comment) return errorResponse('评论不存在', 404);
  if (comment.user_id !== userId && user.role !== 'admin') {
    return errorResponse('无权删除', 403);
  }
  await runDB(env, 'DELETE FROM comments WHERE id = ?', [commentId]);
  await runDB(env, 'UPDATE posts SET comments_count = comments_count - 1 WHERE id = ?', [comment.post_id]);
  return jsonResponse({ success: true, message: '评论已删除' });
}

// ============================================================
//  管理员功能
// ============================================================
async function handleAdminGetUsers(env) {
  const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status, created_at, banner, avatar FROM users');
  return jsonResponse(result.results || []);
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

async function handleAdminGiftDiamond(env, body) {
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount) return errorResponse('请填写完整信息');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: '赠送成功' });
}

async function handleGetHandlers(env) {
  const result = await queryDB(env, 'SELECT id, username, avatar FROM users WHERE role = "handler" AND status = "active"');
  return jsonResponse(result.results || []);
}

// ============================================================
//  充值管理
// ============================================================
async function handleCustomRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效金额');
  const diamond = Math.floor(amount * 10);
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharge_requests (id, user_id, amount, diamond, status, created_at) VALUES (?, ?, ?, ?, "pending", ?)',
    [id, userId, amount, diamond, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: `充值申请已提交，可获得 ${diamond} 红钻` });
}

async function handleAdminGetRecharges(env) {
  const result = await queryDB(env,
    `SELECT r.*, u.username 
     FROM recharge_requests r 
     LEFT JOIN users u ON r.user_id = u.id 
     ORDER BY r.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminApproveRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharge_requests SET status = "approved", handled_at = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  if (recharge.user_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
  }
  return jsonResponse({ success: true, message: '审核通过，红钻已到账' });
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

// ============================================================
//  提现管理
// ============================================================
async function handleRequestWithdraw(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') {
    return errorResponse('只有打手可申请提现', 403);
  }
  const { amount } = body;
  if (!amount || amount < 1) return errorResponse('请输入有效数量');
  const available = Math.max(0, (user.diamond || 0) - 100);
  if (amount > available) {
    return errorResponse(`可提现红钻不足，可用：${available} 红钻（需保留100冻结）`, 400);
  }
  const id = generateId();
  await runDB(env,
    `INSERT INTO withdraw_requests (id, user_id, amount, status, created_at) 
     VALUES (?, ?, ?, "pending", ?)`,
    [id, userId, amount, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '提现申请已提交' });
}

async function handleAdminGetWithdrawals(env) {
  const result = await queryDB(env,
    `SELECT w.*, u.username 
     FROM withdraw_requests w 
     LEFT JOIN users u ON w.user_id = u.id 
     ORDER BY w.created_at DESC`
  );
  return jsonResponse(result.results || []);
}

async function handleAdminApproveWithdraw(env, withdrawId) {
  const result = await queryDB(env, 'SELECT * FROM withdraw_requests WHERE id = ?', [withdrawId]);
  if (!result.results || result.results.length === 0) {
    return errorResponse('提现申请不存在', 404);
  }
  const withdraw = result.results[0];
  if (withdraw.status !== 'pending') {
    return errorResponse('已处理', 400);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [withdraw.amount, withdraw.user_id]);
  await runDB(env,
    'UPDATE withdraw_requests SET status = "approved", handled_at = ? WHERE id = ?',
    [new Date().toISOString(), withdrawId]
  );
  return jsonResponse({ success: true, message: `提现已通过，已扣除 ${withdraw.amount} 红钻` });
}

async function handleAdminRejectWithdraw(env, withdrawId, body) {
  const { reason } = body;
  const result = await queryDB(env, 'SELECT * FROM withdraw_requests WHERE id = ?', [withdrawId]);
  if (!result.results || result.results.length === 0) {
    return errorResponse('提现申请不存在', 404);
  }
  const withdraw = result.results[0];
  if (withdraw.status !== 'pending') {
    return errorResponse('已处理', 400);
  }
  await runDB(env,
    'UPDATE withdraw_requests SET status = "rejected", reject_reason = ?, handled_at = ? WHERE id = ?',
    [reason || '无原因', new Date().toISOString(), withdrawId]
  );
  return jsonResponse({ success: true, message: '已拒绝' });
}

// ============================================================
//  广告管理
// ============================================================
async function handleGetBanners(env) {
  const result = await queryDB(env, 'SELECT * FROM banners ORDER BY sort_order ASC');
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
//  公告管理
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
  await runDB(env,
    'INSERT INTO announces (id, content, images, updated_at) VALUES (?, ?, ?, ?)',
    [generateId(), content || '欢迎使用 QW电竞护航平台！', imagesJson, new Date().toISOString()]
  );
  return jsonResponse({ success: true, message: '公告已更新' });
}

// ============================================================
//  图标管理
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
//  派单系统
// ============================================================
async function handleDispatcherPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('只有派单员或管理员可发布订单', 403);
  }
  const { game, title, desc, price, assignedHandlerId } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  if (price < 1) return errorResponse('价格至少为1红钻');
  if (user.diamond < price) {
    return errorResponse(`红钻不足，需要 ${price} 红钻`, 400);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [price, userId]);
  const orderId = generateId();
  await runDB(env,
    `INSERT INTO orders (id, boss_id, status, price, game, title, description, messages, handler_id) 
     VALUES (?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
    [orderId, userId, parseFloat(price), game || '暗区突围', title, desc || '', 
     JSON.stringify([{ sender: 'system', content: `📋 派单员发布订单：${title}`, time: new Date().toISOString() }]),
     assignedHandlerId || null]
  );
  return jsonResponse({ success: true, orderId, message: `订单发布成功，已冻结 ${price} 红钻` });
}

async function handleDispatcherStats(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, 
    `SELECT 
      COUNT(*) as total,
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
  if (user.role !== 'dispatcher' && user.role !== 'admin') {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, 
    'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC',
    [userId]
  );
  return jsonResponse(result.results || []);
}

// ============================================================
//  客服系统
// ============================================================
async function handleGetPendingRecharges(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
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
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const { requestId, action, rejectReason } = body;
  if (!requestId || !action) return errorResponse('参数不完整');
  if (action !== 'approve' && action !== 'reject') return errorResponse('无效操作');
  const req = await queryDB(env, 'SELECT * FROM recharge_requests WHERE id = ?', [requestId]);
  if (!req.results || req.results.length === 0) return errorResponse('申请不存在');
  const request = req.results[0];
  if (request.status !== 'pending') return errorResponse('已处理');
  if (action === 'approve') {
    if (user.diamond < request.diamond) {
      return errorResponse(`红钻不足，需要 ${request.diamond} 红钻`);
    }
    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [request.diamond, userId]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [request.diamond, request.user_id]);
    await runDB(env,
      'UPDATE recharge_requests SET status = "approved", handler_id = ?, handled_at = ? WHERE id = ?',
      [userId, new Date().toISOString(), requestId]
    );
    return jsonResponse({ success: true, message: `充值已通过，已扣除 ${request.diamond} 红钻` });
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
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const result = await queryDB(env,
    'SELECT id, username, role, avatar FROM users WHERE role NOT IN ("admin", "service")'
  );
  return jsonResponse(result.results || []);
}

async function handleServiceGift(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (user.role !== 'admin' && user.role !== 'service') {
    return errorResponse('权限不足', 403);
  }
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount || amount < 1) return errorResponse('请填写完整信息');
  if (user.diamond < amount) {
    return errorResponse(`红钻不足，需要 ${amount} 红钻`);
  }
  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: `已赠送 ${amount} 红钻` });
}

// ============================================================
//  健康检查
// ============================================================
async function handleHealthCheck(env) {
  return jsonResponse({ status: 'ok', time: new Date().toISOString() });
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
//  订单聊天
// ============================================================
async function handleSendChat(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const { content } = body;
  if (!content) return errorResponse('内容不能为空');
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  let messages = [];
  try { messages = JSON.parse(order.messages || '[]'); } catch (e) { messages = []; }
  messages.push({ sender: 'user', content, time: new Date().toISOString() });
  await runDB(env, 'UPDATE orders SET messages = ? WHERE id = ?', [JSON.stringify(messages), orderId]);
  return jsonResponse({ message: '发送成功' });
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
    // 初始化数据库
    await initDatabase(env);
    
    const authHeader = request.headers.get('Authorization');

    // ===== 公开接口 =====
    if (path === '/api/health' && method === 'GET') return await handleHealthCheck(env);
    if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
    if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
    if (path === '/api/products' && method === 'GET') return await handleGetProducts(env, url);
    if (path === '/api/categories' && method === 'GET') return await handleGetCategories(env);
    if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(env);
    if (path === '/api/handlers' && method === 'GET') return await handleGetHandlers(env);
    if (path === '/api/support-contacts' && method === 'GET') return await handleGetSupportContacts(env);
    if (path === '/api/shops' && method === 'GET') return await handleGetShops(env, url);
    if (path === '/api/banners' && method === 'GET') return await handleGetBanners(env);
    if (path === '/api/icons' && method === 'GET') return await handleGetIcons(env);
    if (path === '/api/posts' && method === 'GET') return await handleGetPosts(env, url);
    if (path.startsWith('/api/products/') && method === 'GET') {
      const productId = path.replace('/api/products/', '');
      return await handleGetProductDetail(env, productId);
    }
    if (path.startsWith('/api/shops/') && path.endsWith('/categories') && method === 'GET') {
      const shopId = path.replace('/api/shops/', '').replace('/categories', '');
      return await handleGetShopCategories(env, shopId);
    }
    if (path.startsWith('/api/shops/') && method === 'GET') {
      const shopId = path.replace('/api/shops/', '');
      return await handleGetShopDetail(env, shopId);
    }
    if (path.startsWith('/api/posts/') && method === 'GET') {
      const postId = path.replace('/api/posts/', '');
      return await handleGetPostDetail(env, postId);
    }

    // ===== 需要登录 =====
    if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
    if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(env, authHeader);
    if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(env, authHeader, body);
    if (path === '/api/mails' && method === 'GET') return await handleGetMails(env, authHeader);
    if (path === '/api/messages/send' && method === 'POST') return await handleSendMessage(env, authHeader, body);
    if (path === '/api/messages/contacts' && method === 'GET') return await handleGetContacts(env, authHeader);
    if (path === '/api/messages/history' && method === 'POST') return await handleGetMessages(env, authHeader, body);
    if (path === '/api/messages/unread' && method === 'GET') return await handleGetUnreadCount(env, authHeader);
    if (path === '/api/recharge/custom' && method === 'POST') return await handleCustomRecharge(env, authHeader, body);
    if (path === '/api/withdraw/request' && method === 'POST') return await handleRequestWithdraw(env, authHeader, body);
    if (path === '/api/user/name' && method === 'PUT') return await handleChangeName(env, authHeader, body);
    if (path === '/api/user/banner' && method === 'PUT') return await handleSetBanner(env, authHeader, body);
    if (path === '/api/user/avatar' && method === 'PUT') return await handleSetAvatar(env, authHeader, body);
    if (path === '/api/posts' && method === 'POST') return await handleCreatePost(env, authHeader, body);
    if (path === '/api/dispatcher/stats' && method === 'GET') return await handleDispatcherStats(env, authHeader);
    if (path === '/api/dispatcher/orders' && method === 'GET') return await handleDispatcherOrders(env, authHeader);
    if (path === '/api/dispatcher/publish' && method === 'POST') return await handleDispatcherPublish(env, authHeader, body);
    
    if (path.startsWith('/api/posts/') && path.endsWith('/like') && method === 'POST') {
      const postId = path.replace('/api/posts/', '').replace('/like', '');
      return await handleLikePost(env, authHeader, postId);
    }
    if (path.startsWith('/api/posts/') && path.endsWith('/comments') && method === 'POST') {
      const postId = path.replace('/api/posts/', '').replace('/comments', '');
      return await handleCreateComment(env, authHeader, postId, body);
    }
    if (path.startsWith('/api/posts/') && method === 'DELETE') {
      const postId = path.replace('/api/posts/', '');
      return await handleDeletePost(env, authHeader, postId);
    }
    if (path.startsWith('/api/comments/') && method === 'DELETE') {
      const commentId = path.replace('/api/comments/', '');
      return await handleDeleteComment(env, authHeader, commentId);
    }
    
    if (path.startsWith('/api/orders/')) {
      const orderId = path.replace('/api/orders/', '');
      if (method === 'GET') return await handleGetOrderDetail(env, authHeader, orderId);
      if (orderId.endsWith('/take')) { const id = orderId.replace('/take', ''); return await handleTakeOrder(env, authHeader, id); }
      if (orderId.endsWith('/submit-complete')) { const id = orderId.replace('/submit-complete', ''); return await handleSubmitComplete(env, authHeader, id); }
      if (orderId.endsWith('/boss-confirm')) { const id = orderId.replace('/boss-confirm', ''); return await handleBossConfirm(env, authHeader, id); }
      if (orderId.endsWith('/refund-request')) { const id = orderId.replace('/refund-request', ''); return await handleRefundRequest(env, authHeader, id, body); }
      if (orderId.endsWith('/chat') && method === 'POST') { const id = orderId.replace('/chat', ''); return await handleSendChat(env, authHeader, id, body); }
    }
    
    if (path.startsWith('/api/mails/') && path.endsWith('/claim') && method === 'PUT') {
      const mailId = path.replace('/api/mails/', '').replace('/claim', '');
      return await handleClaimMail(env, authHeader, mailId);
    }

    // ===== 管理员接口 =====
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        if (path === '/api/admin/users' && method === 'GET') return await handleAdminGetUsers(env);
        if (path === '/api/admin/gift' && method === 'POST') return await handleAdminGiftDiamond(env, body);
        if (path === '/api/admin/recharges' && method === 'GET') return await handleAdminGetRecharges(env);
        if (path === '/api/admin/withdrawals' && method === 'GET') return await handleAdminGetWithdrawals(env);
        if (path === '/api/admin/products' && method === 'GET') return await handleAdminGetProducts(env);
        if (path === '/api/admin/products' && method === 'POST') return await handleAdminCreateProduct(env, body);
        if (path === '/api/admin/categories' && method === 'POST') return await handleAdminCreateCategory(env, body);
        if (path === '/api/admin/announce' && method === 'PUT') return await handleAdminUpdateAnnounce(env, body);
        if (path === '/api/admin/banners' && method === 'POST') return await handleAdminCreateBanner(env, authHeader, body);
        if (path === '/api/admin/icons' && method === 'POST') return await handleAdminSetIcon(env, authHeader, body);
        if (path === '/api/shops' && method === 'POST') return await handleCreateShop(env, authHeader, body);
        if (path === '/api/shop-categories' && method === 'POST') return await handleCreateShopCategory(env, authHeader, body);
        
        if (path.startsWith('/api/admin/users/')) {
          const targetUserId = path.replace('/api/admin/users/', '');
          if (targetUserId.endsWith('/ban') && method === 'PUT') { const id = targetUserId.replace('/ban', ''); return await handleAdminToggleBan(env, id); }
          if (targetUserId.endsWith('/reset-password') && method === 'PUT') { const id = targetUserId.replace('/reset-password', ''); return await handleAdminResetPassword(env, id); }
          if (targetUserId.endsWith('/approve') && method === 'PUT') { const id = targetUserId.replace('/approve', ''); return await handleApproveHandler(env, id); }
          if (targetUserId.endsWith('/username') && method === 'PUT') { const id = targetUserId.replace('/username', ''); return await handleChangeUsername(env, id, body); }
        }
        
        if (path.startsWith('/api/admin/recharges/')) {
          const rechargeId = path.replace('/api/admin/recharges/', '');
          if (rechargeId.endsWith('/approve') && method === 'PUT') { const id = rechargeId.replace('/approve', ''); return await handleAdminApproveRecharge(env, id); }
          if (rechargeId.endsWith('/reject') && method === 'PUT') { const id = rechargeId.replace('/reject', ''); return await handleAdminRejectRecharge(env, id); }
          if (method === 'DELETE') return await handleAdminDeleteRecharge(env, rechargeId);
        }
        
        if (path.startsWith('/api/admin/withdrawals/')) {
          const withdrawId = path.replace('/api/admin/withdrawals/', '');
          if (withdrawId.endsWith('/approve') && method === 'PUT') { const id = withdrawId.replace('/approve', ''); return await handleAdminApproveWithdraw(env, id); }
          if (withdrawId.endsWith('/reject') && method === 'PUT') { const id = withdrawId.replace('/reject', ''); return await handleAdminRejectWithdraw(env, id, body); }
        }
        
        if (path.startsWith('/api/admin/products/')) {
          const productId = path.replace('/api/admin/products/', '');
          if (productId.endsWith('/unshelf') && method === 'PUT') { const id = productId.replace('/unshelf', ''); return await handleAdminUnshelf(env, id); }
          if (productId.endsWith('/reshelf') && method === 'PUT') { const id = productId.replace('/reshelf', ''); return await handleAdminReshelf(env, id); }
          if (productId.endsWith('/edit') && method === 'PUT') { const id = productId.replace('/edit', ''); return await handleAdminUpdateProduct(env, id, body); }
          if (method === 'DELETE') return await handleAdminDeleteProduct(env, productId);
        }
        
        if (path.startsWith('/api/admin/categories/')) {
          const categoryId = path.replace('/api/admin/categories/', '');
          if (categoryId.endsWith('/edit') && method === 'PUT') { const id = categoryId.replace('/edit', ''); return await handleAdminUpdateCategory(env, id, body); }
          if (method === 'DELETE') return await handleAdminDeleteCategory(env, categoryId);
        }
        
        if (path.startsWith('/api/admin/banners/') && method === 'DELETE') {
          const bannerId = path.replace('/api/admin/banners/', '');
          return await handleAdminDeleteBanner(env, authHeader, bannerId);
        }
        
        if (path.startsWith('/api/admin/icons/') && method === 'DELETE') {
          const key = path.replace('/api/admin/icons/', '');
          return await handleAdminDeleteIcon(env, authHeader, key);
        }
        
        if (path.startsWith('/api/shops/')) {
          const shopId = path.replace('/api/shops/', '');
          if (shopId.endsWith('/toggle') && method === 'PUT') {
            const id = shopId.replace('/toggle', '');
            return await handleToggleShop(env, authHeader, id);
          }
          if (method === 'PUT') return await handleUpdateShop(env, authHeader, shopId, body);
          if (method === 'DELETE') return await handleDeleteShop(env, authHeader, shopId);
        }
        
        if (path.startsWith('/api/shop-categories/') && method === 'DELETE') {
          const categoryId = path.replace('/api/shop-categories/', '');
          return await handleDeleteShopCategory(env, authHeader, categoryId);
        }
      }
    }

    // ===== 客服接口 =====
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && (user.role === 'service' || user.role === 'admin')) {
        if (path === '/api/service/recharges' && method === 'GET') return await handleGetPendingRecharges(env, authHeader);
        if (path === '/api/service/process' && method === 'POST') return await handleProcessRecharge(env, authHeader, body);
        if (path === '/api/service/users' && method === 'GET') return await handleGetUsersForService(env, authHeader);
        if (path === '/api/service/gift' && method === 'POST') return await handleServiceGift(env, authHeader, body);
      }
    }

    return errorResponse('接口不存在', 404);
  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}