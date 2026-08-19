// ============================================================
//  QW电竞 - 后端 API（Cloudflare D1 版本）
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

async function handleGetProducts(env) {
  const result = await queryDB(env, 'SELECT * FROM products WHERE hidden = 0 ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleGetAnnounce(env) {
  const result = await queryDB(env, 'SELECT * FROM announces ORDER BY updated_at DESC LIMIT 1');
  const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
  return jsonResponse(data);
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

async function handleGetMe(env, authHeader) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  const { password, ...rest } = user;
  return jsonResponse(rest);
}

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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
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
      if (path === '/api/login' && method === 'POST') return await handleLogin(env, body);
      if (path === '/api/register' && method === 'POST') return await handleRegister(env, body);
      if (path === '/api/products' && method === 'GET') return await handleGetProducts(env);
      if (path === '/api/announce' && method === 'GET') return await handleGetAnnounce(env);
      if (path === '/api/me' && method === 'GET') return await handleGetMe(env, authHeader);
      if (path === '/api/orders/my' && method === 'GET') return await handleGetMyOrders(env, authHeader);
      if (path === '/api/orders/buy' && method === 'POST') return await handleBuyProduct(env, authHeader, body);
      return errorResponse('接口不存在', 404);
    } catch (err) {
      console.error('Error:', err);
      return errorResponse(err.message || '服务器错误', 500);
    }
  }
};
// 自动部署测试 - 2026-08-20