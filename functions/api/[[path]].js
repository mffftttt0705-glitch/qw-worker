// ============================================================
//  QW电竞 - 完整后端 API（Pages Functions 版本）
//  包含：用户、商品、订单、充值、公告、邮件、聊天等全部功能
//  新增：打手审核、修改用户名、商品图片、编辑商品
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
//  用户相关
// ============================================================

async function handleRegister(env, body) {
  const { username, password, role, status } = body;
  if (!username || !password) return errorResponse('请填写用户名和密码');

  const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
  if (existing.results && existing.results.length > 0) {
    return errorResponse('用户名已存在');
  }

  const id = generateId();
  const userStatus = role === 'handler' ? 'pending' : (status || 'active');
  await runDB(env,
    'INSERT INTO users (id, username, password, role, diamond, balance, status) VALUES (?, ?, ?, ?, 0, 0, ?)',
    [id, username, password, role || 'boss', userStatus]
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
  if (user.status === 'banned') return errorResponse('账号已被封禁');
  if (user.status === 'pending') return errorResponse('账号待审核，请等待管理员通过');

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
//  商品相关（支持图片、编辑）
// ============================================================

async function handleGetProducts(env) {
  const result = await queryDB(env, 'SELECT * FROM products WHERE hidden = 0 ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminGetProducts(env) {
  const result = await queryDB(env, 'SELECT * FROM products ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminCreateProduct(env, body) {
  const { game, title, desc, price, quantity, image } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const id = generateId();
  await runDB(env,
    'INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)',
    [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '']
  );
  return jsonResponse({ success: true, id });
}

// 新增：编辑商品
async function handleAdminUpdateProduct(env, productId, body) {
  const { game, title, desc, price, quantity, image } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  await runDB(env,
    'UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ? WHERE id = ?',
    [game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', productId]
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
//  订单相关
// ============================================================

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

  const sold = product.sold || 0;
  if (product.quantity <= sold) return errorResponse('库存不足');

  const diamondCost = product.price * 10;
  if (user.diamond < diamondCost) return errorResponse('红钻不足');

  await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);

  const orderId = generateId();
  await runDB(env,
    'INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?)',
    [orderId, productId, userId, product.price, product.game, product.title, product.desc || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date().toISOString() }])]
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
  if (user.role === 'boss') {
    sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
  } else if (user.role === 'handler') {
    const pendingResult = await queryDB(env, 'SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC');
    const myResult = await queryDB(env, 'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC', [userId]);
    const all = [...(pendingResult.results || []), ...(myResult.results || [])];
    const seen = new Set();
    const unique = all.filter(o => {
      const key = o.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return jsonResponse(unique);
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
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin') {
    return errorResponse('无权查看', 403);
  }
  return jsonResponse(order);
}

// ============================================================
//  打手功能
// ============================================================

async function handleTakeOrder(env, authHeader, orderId) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'handler') return errorResponse('只有打手可接单');
  if (user.status !== 'active') return errorResponse('账号未激活，请联系管理员');

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
  if (user.role !== 'boss') return errorResponse('只有老板可操作');

  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId) return errorResponse('不是你的订单', 403);
  if (order.status !== 'review') return errorResponse('只有待验收可确认');

  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '已确认完成，等待管理员结算' });
}

async function handleRefundRequest(env, authHeader, orderId, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);
  const user = await getUserById(env, userId);
  if (!user) return errorResponse('用户不存在', 404);
  if (user.role !== 'boss') return errorResponse('只有老板可发起退款');

  const { reason } = body;
  if (!reason) return errorResponse('请填写退款原因');

  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  if (!order) return errorResponse('订单不存在', 404);
  if (order.boss_id !== userId) return errorResponse('不是你的订单', 403);
  if (order.status === 'completed') return errorResponse('已完成订单不可退款');
  if (order.status === 'refunded' || order.status === 'refund_pending') return errorResponse('已处理退款');

  await runDB(env, 'UPDATE orders SET status = "refund_pending", refund_reason = ? WHERE id = ?', [reason, orderId]);
  return jsonResponse({ success: true, message: '退款申请已提交' });
}

// ============================================================
//  管理员功能
// ============================================================

async function handleAdminGetOrders(env) {
  const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminGetUsers(env) {
  const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status FROM users');
  return jsonResponse(result.results || []);
}

async function handleAdminAssignHandler(env, orderId, body) {
  const { handlerId } = body;
  if (!handlerId) return errorResponse('请选择打手');
  const userResult = await queryDB(env, 'SELECT * FROM users WHERE id = ? AND role = "handler"', [handlerId]);
  if (!userResult.results || userResult.results.length === 0) {
    return errorResponse('打手不存在');
  }
  await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?', [handlerId, new Date().toISOString(), orderId]);
  return jsonResponse({ message: '指派成功' });
}

async function handleAdminForceComplete(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '强制完成成功' });
}

async function handleAdminConfirm(env, orderId) {
  await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?', [new Date().toISOString(), orderId]);
  return jsonResponse({ message: '验收通过' });
}

async function handleAdminReject(env, orderId, body) {
  const { reason } = body;
  await runDB(env, 'UPDATE orders SET status = "rejected", refund_reason = ? WHERE id = ?', [reason || '无原因', orderId]);
  return jsonResponse({ message: '已驳回' });
}

async function handleAdminCancelOrder(env, orderId) {
  const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
  const order = (result.results && result.results[0]) || null;
  await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
  if (order && order.boss_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price * 10, order.boss_id]);
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
    await runDB(env, 'UPDATE users SET balance = balance + ? WHERE id = ?', [amount, order.handler_id]);
  }
  await runDB(env, 'UPDATE orders SET settled = 1, settled_amount = ? WHERE id = ?', [amount, orderId]);
  return jsonResponse({ success: true, message: `结算成功 ¥${amount}` });
}

async function handleAdminDirectPublish(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);

  const { game, title, desc, price } = body;
  if (!title || !price) return errorResponse('请填写完整信息');
  const orderId = generateId();
  await runDB(env,
    'INSERT INTO orders (id, boss_id, status, price, game, title, description, messages) VALUES (?, ?, "pending", ?, ?, ?, ?, ?)',
    [orderId, userId, parseFloat(price), game || '暗区突围', title, desc || '', JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date().toISOString() }])]
  );
  return jsonResponse({ success: true, orderId });
}

async function handleAdminDeleteOrder(env, orderId) {
  await runDB(env, 'DELETE FROM orders WHERE id = ?', [orderId]);
  return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  充值相关
// ============================================================

async function handleCreateRecharge(env, authHeader, body) {
  const userId = verifyAndGetUserId(authHeader);
  if (!userId) return errorResponse('请先登录', 401);

  const { amount, diamond } = body;
  const id = generateId();
  await runDB(env,
    'INSERT INTO recharges (id, user_id, amount, diamond, status) VALUES (?, ?, ?, ?, "pending")',
    [id, userId, amount, diamond]
  );
  return jsonResponse({ message: '充值申请已提交' });
}

async function handleAdminGetRecharges(env) {
  const result = await queryDB(env, 'SELECT * FROM recharges ORDER BY created_at DESC');
  return jsonResponse(result.results || []);
}

async function handleAdminApproveRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharges WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');

  await runDB(env, 'UPDATE recharges SET status = "approved", approve_time = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  if (recharge.user_id) {
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
  }
  return jsonResponse({ success: true, message: '审核通过，红钻已到账' });
}

async function handleAdminRejectRecharge(env, rechargeId) {
  const result = await queryDB(env, 'SELECT * FROM recharges WHERE id = ?', [rechargeId]);
  const recharge = (result.results && result.results[0]) || null;
  if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
  await runDB(env, 'UPDATE recharges SET status = "rejected", approve_time = ? WHERE id = ?', [new Date().toISOString(), rechargeId]);
  return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleAdminDeleteRecharge(env, rechargeId) {
  await runDB(env, 'DELETE FROM recharges WHERE id = ?', [rechargeId]);
  return jsonResponse({ success: true, message: '已删除' });
}

async function handleAdminGiftDiamond(env, body) {
  const { targetUserId, amount } = body;
  if (!targetUserId || !amount) return errorResponse('请填写完整信息');
  await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
  return jsonResponse({ success: true, message: '赠送成功' });
}

// ============================================================
//  公告相关
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
//  邮件相关
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
//  聊天相关
// ============================================================

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
  if (order.boss_id !== userId && order.handler_id !== userId && user.role !== 'admin') {
    return errorResponse('无权操作', 403);
  }

  const sender = user.role === 'boss' ? 'boss' : user.role === 'handler' ? 'handler' : 'admin';
  let messages = [];
  try {
    messages = JSON.parse(order.messages || '[]');
  } catch (e) { messages = []; }
  messages.push({ sender, content, time: new Date().toISOString() });

  await runDB(env, 'UPDATE orders SET messages = ? WHERE id = ?', [JSON.stringify(messages), orderId]);
  return jsonResponse({ message: '发送成功' });
}

// ============================================================
//  管理员：用户管理
// ============================================================

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
  if (user.role !== 'handler') return errorResponse('该用户不是打手');
  if (user.status !== 'pending') return errorResponse('该用户不需要审核');
  await runDB(env, 'UPDATE users SET status = "active" WHERE id = ?', [targetUserId]);
  return jsonResponse({ success: true, message: '打手审核通过' });
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
//  Pages Functions 入口
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

    // ===== 测试接口 =====
    if (path === '/api/test' && method === 'GET') {
      return jsonResponse({ message: 'Pages Functions 运行正常！' });
    }

    // ===== 公开接口 =====
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

    // ===== 需要登录的接口 =====
    if (path === '/api/me' && method === 'GET') {
      return await handleGetMe(env, authHeader);
    }
    if (path === '/api/orders/my' && method === 'GET') {
      return await handleGetMyOrders(env, authHeader);
    }
    if (path === '/api/orders/buy' && method === 'POST') {
      return await handleBuyProduct(env, authHeader, body);
    }
    if (path === '/api/recharges' && method === 'POST') {
      return await handleCreateRecharge(env, authHeader, body);
    }
    if (path === '/api/mails' && method === 'GET') {
      return await handleGetMails(env, authHeader);
    }

    // ===== 带参数的订单接口 =====
    if (path.startsWith('/api/orders/')) {
      const orderId = path.replace('/api/orders/', '');
      if (method === 'GET') {
        return await handleGetOrderDetail(env, authHeader, orderId);
      }
      if (orderId.endsWith('/take')) {
        const id = orderId.replace('/take', '');
        return await handleTakeOrder(env, authHeader, id);
      }
      if (orderId.endsWith('/submit-complete')) {
        const id = orderId.replace('/submit-complete', '');
        return await handleSubmitComplete(env, authHeader, id);
      }
      if (orderId.endsWith('/boss-confirm')) {
        const id = orderId.replace('/boss-confirm', '');
        return await handleBossConfirm(env, authHeader, id);
      }
      if (orderId.endsWith('/refund-request')) {
        const id = orderId.replace('/refund-request', '');
        return await handleRefundRequest(env, authHeader, id, body);
      }
      if (orderId.endsWith('/chat')) {
        const id = orderId.replace('/chat', '');
        return await handleSendChat(env, authHeader, id, body);
      }
    }

    // ===== 带参数的邮件接口 =====
    if (path.startsWith('/api/mails/') && path.endsWith('/claim') && method === 'PUT') {
      const mailId = path.replace('/api/mails/', '').replace('/claim', '');
      return await handleClaimMail(env, authHeader, mailId);
    }

    // ===== 管理员接口 =====
    const userId = verifyAndGetUserId(authHeader);
    if (userId) {
      const user = await getUserById(env, userId);
      if (user && user.role === 'admin') {

        // 订单管理
        if (path === '/api/admin/orders' && method === 'GET') {
          return await handleAdminGetOrders(env);
        }
        if (path === '/api/admin/orders/direct' && method === 'POST') {
          return await handleAdminDirectPublish(env, authHeader, body);
        }
        if (path.startsWith('/api/admin/orders/')) {
          const orderId = path.replace('/api/admin/orders/', '');
          if (orderId.endsWith('/assign') && method === 'PUT') {
            const id = orderId.replace('/assign', '');
            return await handleAdminAssignHandler(env, id, body);
          }
          if (orderId.endsWith('/force-complete') && method === 'PUT') {
            const id = orderId.replace('/force-complete', '');
            return await handleAdminForceComplete(env, id);
          }
          if (orderId.endsWith('/confirm') && method === 'PUT') {
            const id = orderId.replace('/confirm', '');
            return await handleAdminConfirm(env, id);
          }
          if (orderId.endsWith('/reject') && method === 'PUT') {
            const id = orderId.replace('/reject', '');
            return await handleAdminReject(env, id, body);
          }
          if (orderId.endsWith('/cancel') && method === 'PUT') {
            const id = orderId.replace('/cancel', '');
            return await handleAdminCancelOrder(env, id);
          }
          if (orderId.endsWith('/settle') && method === 'PUT') {
            const id = orderId.replace('/settle', '');
            return await handleAdminSettle(env, id, body);
          }
          if (method === 'DELETE') {
            return await handleAdminDeleteOrder(env, orderId);
          }
        }

        // 商品管理（含编辑）
        if (path === '/api/admin/products' && method === 'GET') {
          return await handleAdminGetProducts(env);
        }
        if (path === '/api/admin/products' && method === 'POST') {
          return await handleAdminCreateProduct(env, body);
        }
        if (path.startsWith('/api/admin/products/')) {
          const productId = path.replace('/api/admin/products/', '');
          // 编辑商品（新增）
          if (productId.endsWith('/edit') && method === 'PUT') {
            const id = productId.replace('/edit', '');
            return await handleAdminUpdateProduct(env, id, body);
          }
          if (productId.endsWith('/unshelf') && method === 'PUT') {
            const id = productId.replace('/unshelf', '');
            return await handleAdminUnshelf(env, id);
          }
          if (productId.endsWith('/reshelf') && method === 'PUT') {
            const id = productId.replace('/reshelf', '');
            return await handleAdminReshelf(env, id);
          }
          if (method === 'DELETE') {
            return await handleAdminDeleteProduct(env, productId);
          }
        }

        // 充值管理
        if (path === '/api/admin/recharges' && method === 'GET') {
          return await handleAdminGetRecharges(env);
        }
        if (path.startsWith('/api/admin/recharges/')) {
          const rechargeId = path.replace('/api/admin/recharges/', '');
          if (rechargeId.endsWith('/approve') && method === 'PUT') {
            const id = rechargeId.replace('/approve', '');
            return await handleAdminApproveRecharge(env, id);
          }
          if (rechargeId.endsWith('/reject') && method === 'PUT') {
            const id = rechargeId.replace('/reject', '');
            return await handleAdminRejectRecharge(env, id);
          }
          if (method === 'DELETE') {
            return await handleAdminDeleteRecharge(env, rechargeId);
          }
        }

        // 用户管理
        if (path === '/api/admin/users' && method === 'GET') {
          return await handleAdminGetUsers(env);
        }
        if (path === '/api/admin/gift' && method === 'POST') {
          return await handleAdminGiftDiamond(env, body);
        }
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

        // 公告管理
        if (path === '/api/admin/announce' && method === 'PUT') {
          return await handleAdminUpdateAnnounce(env, body);
        }
      }
    }

    return errorResponse('接口不存在', 404);

  } catch (err) {
    console.error('Pages Functions 错误:', err);
    return errorResponse(err.message || '服务器内部错误', 500);
  }
}