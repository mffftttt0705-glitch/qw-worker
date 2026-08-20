// ============================================================
//  QW电竞 - 后端 API（Pages Functions 版本）
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

// ===== 注册 =====
async function handleRegister(env, body) {
  const { username, password, role } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已存在');
  }

  const id = generateId();
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status) VALUES (?, ?, ?, ?, 0, 0, "active")',
    [id, username, password, role || 'boss']
  );

  return jsonResponse({ message: '注册成功', id });
}

// ===== 登录 =====
async function handleLogin(env, body) {
  const { username, password } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  const user = (result.results && result.results[0]) || null;
  if (!user) return errorResponse('用户不存在');
  if (user.password !== password) return errorResponse('密码错误');

  const token = generateId() + '.' + user.id;

  return jsonResponse({
    token,
    user: {
      id: user.id,
      username: user.username,
      role: user.role || 'boss',
      diamond: user.diamond || 0,
      balance: user.balance || 0,
      status: user.status || 'active'
    }
  });
}

// ===== 商品列表 =====
async function handleGetProducts(env) {
  const result = await queryDB(env, 'SELECT * FROM products WHERE hidden = 0 ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

// ===== 公告 =====
async function handleGetAnnounce(env) {
  const result = await queryDB(env, 'SELECT * FROM announces ORDER BY updated_at DESC LIMIT 1');
  const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
  return jsonResponse(data);
}

// ===== 获取用户 =====
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

// ===== 个人信息 =====
async function handleGetMe(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { password, ...rest } = user;
  return jsonResponse(rest);
}

// ===== 我的订单 =====
async function handleGetMyOrders(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);

  let sql = '';
  if (user.role === 'boss') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else if (user.role === 'handler') {
    sql = 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC';
  } else {
    return errorResponse('无权查看', 403);
  }
  const result = await queryDB(env, sql, [userId]);
  return jsonResponse(result.results || []);
}

// ===== 购买商品 =====
async function handleBuyProduct(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);

  const { productId } = body;
  if (!productId) return errorResponse('请选择商品');

  const prodResult = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
  const product = (prodResult.results && prodResult.results[0]) || null;
  if (!product) return errorResponse('商品不存在', 404);
  if (product.quantity <= product.sold) return errorResponse('库存不足');

  const diamondCost = product.price * 10;
  if (user.diamond < diamondCost) return errorResponse('红钻不足');

  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);

  const orderId = generateId();
  await runDB(env,
    'INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?)',
    [orderId, productId, userId, product.price, product.game, product.title, product.desc || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date() }])]
  );

  await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
  return jsonResponse({ orderId, message: '购买成功' });
}

// ============================================================
//  Pages Functions 入口
// ============================================================
export async function onRequest(context) {
  const request = context.request;
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // ⚠️ 关键：从 context.env 获取 D1 绑定
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

    // 测试接口
    if (path === '/api/test' && method === 'GET') {
      return jsonResponse({ message: 'Pages Functions 运行正常！' });
    }

    // 公开接口
    if (path === '/api/register' && method === 'POST') {
      return await handleRegister(env, body);
    }
    if (path === '/api/login' && method === 'POST') {
      return await handleLogin(env, body);
    }
    if (path === '/api/products' && method === 'GET') {
      return await handleGetProducts(env);
    }
    if (path === '/api/announce' && method === 'GET') {
      return await handleGetAnnounce(env);
    }

    // 需要登录的接口
    if (path === '/api/me' && method === 'GET') {
      return await handleGetMe(env, authHeader);
    }
    if (path === '/api/orders/my' && method === 'GET') {
      return await handleGetMyOrders(env, authHeader);
    }
    if (path === '/api/orders/buy' && method === 'POST') {
      return await handleBuyProduct(env, authHeader, body);
    }

    // 管理员接口（简化版）
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {
        if (path === '/api/admin/orders' && method === 'GET') {
          const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
          return jsonResponse(result.results || []);
        }
        if (path === '/api/admin/users' && method === 'GET') {
          const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status FROM users');
          return jsonResponse(result.results || []);
        }
        if (path === '/api/admin/products' && method === 'GET') {
          const result = await queryDB(env, 'SELECT * FROM products ORDER BY created_at DESC');
          return jsonResponse(result.results || []);
        }
        if (path === '/api/admin/products' && method === 'POST') {
          const { game, title, description, price, quantity } = body;
          if (!title || !price) return errorResponse('请填写完整信息');
          const id = generateId();
          await runDB(env,
            'INSERT INTO products (id, game, title, description, price, quantity, sold, hidden) VALUES (?, ?, ?, ?, ?, ?, 0, 0)',
            [id, game || '暗区突围', title, description || '', parseFloat(price), parseInt(quantity) || 1]
          );
          return jsonResponse({ success: true, id });
        }
        if (path === '/api/admin/orders/direct' && method === 'POST') {
          const { game, title, description, price } = body;
          if (!title || !price) return errorResponse('请填写完整信息');
          const orderId = generateId();
          await runDB(env,
            'INSERT INTO orders (id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, "pending", ?, ?, ?, ?, ?)',
            [orderId, userId, parseFloat(price), game || '暗区突围', title, description || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date() }])]
          );
          return jsonResponse({ success: true, orderId });
        }
      }
    }

    return errorResponse('接口不存在', 404);

  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}