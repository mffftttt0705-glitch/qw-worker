// ============================================================
//  QW电竞 - 完整后端 API（Pages Functions 版本）
//  功能：商城（无店铺过滤）+ 派单员 + 商品管理 + 订单管理
//  修复：商品显示 + 登录保持 + 派单员 + 红点
// ============================================================

// ===== IP注册缓存 =====
const registerCache = {};
const loginCache = {};

function cleanRegisterCache(ip) {
    const now = Date.now();
    if (registerCache[ip]) {
        registerCache[ip] = registerCache[ip].filter(time => now - time < 3600000);
        if (registerCache[ip].length === 0) {
            delete registerCache[ip];
        }
    }
}

function cleanLoginCache(ip) {
    const now = Date.now();
    if (loginCache[ip]) {
        loginCache[ip] = loginCache[ip].filter(time => now - time < 60000);
        if (loginCache[ip].length === 0) {
            delete loginCache[ip];
        }
    }
}

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

async function handleRegister(env, body, request) {
    const { username, password, role, status, phone } = body;
    if (!username || !password) return errorResponse('请填写用户名和密码');

    const clientIP = request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For') ||
        request.headers.get('X-Real-IP') ||
        'unknown';

    cleanRegisterCache(clientIP);
    if (registerCache[clientIP] && registerCache[clientIP].length >= 2) {
        return errorResponse('注册过于频繁，请1小时后再试', 429);
    }

    const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
    if (existing.results && existing.results.length > 0) {
        return errorResponse('用户名已存在');
    }

    const id = generateId();
    const userStatus = (role === 'handler' || role === 'dispatcher') ? 'pending' : (status || 'active');
    await runDB(env,
        'INSERT INTO users (id, username, password, role, diamond, balance, status, phone, register_ip, created_at) VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?)',
        [id, username, password, role || 'boss', userStatus, phone || '', clientIP, new Date().toISOString()]
    );

    if (!registerCache[clientIP]) {
        registerCache[clientIP] = [];
    }
    registerCache[clientIP].push(Date.now());

    return jsonResponse({ message: '注册成功', id, needApproval: role === 'handler' || role === 'dispatcher' });
}

async function handleLogin(env, body, request) {
    const { username, password } = body;
    if (!username || !password) return errorResponse('请填写用户名和密码');

    const clientIP = request.headers.get('CF-Connecting-IP') ||
        request.headers.get('X-Forwarded-For') ||
        request.headers.get('X-Real-IP') ||
        'unknown';

    cleanLoginCache(clientIP);
    if (loginCache[clientIP] && loginCache[clientIP].length >= 3) {
        return errorResponse('登录过于频繁，请1分钟后再试', 429);
    }

    const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
    const user = (result.results && result.results[0]) || null;
    if (!user) return errorResponse('用户不存在');
    if (user.password !== password) return errorResponse('密码错误');
    if (user.status === 'banned') return errorResponse('账号已被封禁');
    if (user.status === 'pending') return errorResponse('账号待审核，请等待管理员通过');

    if (!loginCache[clientIP]) {
        loginCache[clientIP] = [];
    }
    loginCache[clientIP].push(Date.now());

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
//  商品相关（关键修复：不过滤 shop_id，所有商品直接显示）
// ============================================================

async function handleGetProducts(env) {
    const result = await queryDB(env, 'SELECT * FROM products WHERE hidden = 0 ORDER BY created_at DESC');
    return jsonResponse(result.results || []);
}

async function handleGetProductDetail(env, productId) {
    const result = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
    const product = (result.results && result.results[0]) || null;
    if (!product) return errorResponse('商品不存在', 404);
    return jsonResponse(product);
}

async function handleAdminGetProducts(env) {
    const result = await queryDB(env, 'SELECT * FROM products ORDER BY created_at DESC');
    const products = (result.results || []).map(p => ({
        ...p,
        hidden: p.hidden === 1 || p.hidden === true
    }));
    return jsonResponse(products);
}

async function handleAdminCreateProduct(env, body) {
    const { game, title, desc, price, quantity, image, detail_images, detail_desc } = body;
    if (!title || !price) return errorResponse('请填写完整信息');
    const id = generateId();
    const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
    await runDB(env,
        `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, detail_images, detail_desc) 
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?)`,
        [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', detailImagesJson, detail_desc || '']
    );
    return jsonResponse({ success: true, id });
}

async function handleAdminUpdateProduct(env, productId, body) {
    const { game, title, desc, price, quantity, image, detail_images, detail_desc } = body;
    if (!title || !price) return errorResponse('请填写完整信息');
    const detailImagesJson = Array.isArray(detail_images) ? JSON.stringify(detail_images) : (detail_images || '[]');
    await runDB(env,
        'UPDATE products SET game = ?, title = ?, description = ?, price = ?, quantity = ?, image = ?, detail_images = ?, detail_desc = ? WHERE id = ?',
        [game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', detailImagesJson, detail_desc || '', productId]
    );
    return jsonResponse({ success: true, message: '商品已更新' });
}

async function handleAdminUnshelf(env, productId) {
    const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('商品不存在', 404);
    }
    await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
    return jsonResponse({ success: true, message: '已下架' });
}

async function handleAdminReshelf(env, productId) {
    const check = await queryDB(env, 'SELECT * FROM products WHERE id = ?', [productId]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('商品不存在', 404);
    }
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

    const { productId, assignedHandlerId } = body;
    if (!productId) return errorResponse('请选择商品');

    const prodResult = await queryDB(env, 'SELECT * FROM products WHERE id = ? AND hidden = 0', [productId]);
    const product = (prodResult.results && prodResult.results[0]) || null;
    if (!product) return errorResponse('商品不存在', 404);

    const sold = product.sold || 0;
    if (product.quantity <= sold) return errorResponse('库存不足');

    const diamondCost = product.price * 10;
    if (user.diamond < diamondCost) return errorResponse('红钻不足');

    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [diamondCost, userId]);

    const orderId = generateId();
    const status = assignedHandlerId ? 'ongoing' : 'pending';
    const messages = [{ sender: 'system', content: assignedHandlerId ? '🎉 订单已创建并指派打手' : '🎉 订单已创建', time: new Date().toISOString() }];

    await runDB(env,
        `INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages, assigned_handler_id, shop_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, productId, userId, status, product.price, product.game, product.title, product.desc || '', JSON.stringify(messages), assignedHandlerId || null, 'platform']
    );

    if (assignedHandlerId) {
        await runDB(env, 'UPDATE orders SET handler_id = ?, start_time = ? WHERE id = ?', [assignedHandlerId, new Date().toISOString(), orderId]);
    }

    await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
    return jsonResponse({ orderId, message: '购买成功' });
}

async function handleDirectPublish(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    if (user.role !== 'admin' && user.role !== 'dispatcher') {
        return errorResponse('无权限，只有管理员或派单员可以发布订单', 403);
    }

    const { game, title, desc, price, assignedHandlerId } = body;
    if (!title || !price) return errorResponse('请填写完整信息');

    const orderId = generateId();
    const status = assignedHandlerId ? 'ongoing' : 'pending';
    const messages = [{ sender: 'system', content: assignedHandlerId ? '🎉 订单已创建并指派打手' : '🎉 订单已创建', time: new Date().toISOString() }];

    await runDB(env,
        `INSERT INTO orders (id, boss_id, status, price, game, title, description, messages, assigned_handler_id, dispatcher_id, shop_id) 
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [orderId, userId, status, parseFloat(price), game || '暗区突围', title, desc || '', JSON.stringify(messages), assignedHandlerId || null, userId, 'platform']
    );

    if (assignedHandlerId) {
        await runDB(env, 'UPDATE orders SET handler_id = ?, start_time = ? WHERE id = ?', [assignedHandlerId, new Date().toISOString(), orderId]);
    }

    return jsonResponse({ success: true, orderId });
}

async function handleCancelOrder(env, authHeader, orderId, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    const { reason } = body;
    const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
    const order = (result.results && result.results[0]) || null;
    if (!order) return errorResponse('订单不存在', 404);

    if (order.status === 'completed' || order.status === 'settled') {
        return errorResponse('已完成或已结算的订单不能撤销', 400);
    }
    if (order.status === 'canceled') {
        return errorResponse('订单已撤销', 400);
    }

    if (user.role === 'dispatcher' && order.dispatcher_id !== userId) {
        return errorResponse('无权撤销其他派单员发布的订单', 403);
    }

    if (order.boss_id && order.status !== 'canceled') {
        await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price * 10, order.boss_id]);
    }

    await runDB(env, 'UPDATE orders SET status = "canceled", cancel_reason = ?, cancel_time = ? WHERE id = ?',
        [reason || '管理员撤销', new Date().toISOString(), orderId]);

    return jsonResponse({ success: true, message: '订单已撤销' });
}

async function handleGetAvailableHandlers(env) {
    const result = await queryDB(env, 'SELECT id, username, balance, status FROM users WHERE role = "handler" AND status = "active"');
    return jsonResponse(result.results || []);
}

async function handleGetMyOrders(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    let sql = '';
    let params = [];

    if (user.role === 'boss') {
        sql = 'SELECT * FROM orders WHERE boss_id = ? ORDER BY created_at DESC';
        params = [userId];
    } else if (user.role === 'handler') {
        const pendingResult = await queryDB(env,
            'SELECT * FROM orders WHERE status = "pending" ORDER BY created_at DESC'
        );
        const myResult = await queryDB(env,
            'SELECT * FROM orders WHERE handler_id = ? ORDER BY created_at DESC',
            [userId]
        );
        const all = [...(pendingResult.results || []), ...(myResult.results || [])];
        const seen = new Set();
        const unique = all.filter(o => {
            const key = o.id;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        });
        return jsonResponse(unique);
    } else if (user.role === 'dispatcher') {
        sql = 'SELECT * FROM orders WHERE dispatcher_id = ? ORDER BY created_at DESC';
        params = [userId];
    } else {
        return errorResponse('无权查看', 403);
    }

    const result = await queryDB(env, sql, params);
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
    if (order.boss_id !== userId && order.handler_id !== userId && order.dispatcher_id !== userId && user.role !== 'admin') {
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
    if (order && order.boss_id && order.status !== 'canceled') {
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

async function handleAdminGetRechargePendingCount(env) {
    const result = await queryDB(env, 'SELECT COUNT(*) as count FROM recharges WHERE status = "pending"');
    const count = (result.results && result.results[0] && result.results[0].count) || 0;
    return jsonResponse({ count: count });
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

async function handleAdminGetUserPendingCount(env) {
    const result = await queryDB(env, 'SELECT COUNT(*) as count FROM users WHERE status = "pending"');
    const count = (result.results && result.results[0] && result.results[0].count) || 0;
    return jsonResponse({ count: count });
}

// ============================================================
//  打赏打手
// ============================================================

async function handleTip(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    const { handlerId, amount } = body;
    if (!handlerId || !amount) return errorResponse('请选择打手并输入数量', 400);
    if (amount < 1) return errorResponse('红钻数量至少为1', 400);

    const handler = await getUserById(env, handlerId);
    if (!handler) return errorResponse('打手不存在', 404);
    if (handler.role !== 'handler') return errorResponse('该用户不是打手', 400);

    if (user.diamond < amount) return errorResponse('红钻不足', 400);

    await runDB(env, 'UPDATE users SET diamond = diamond - ? WHERE id = ?', [amount, userId]);
    await runDB(env, 'UPDATE users SET balance = balance + ? WHERE id = ?', [amount, handlerId]);

    const logId = generateId();
    await runDB(env,
        'INSERT INTO tips (id, from_user, to_user, amount, created_at) VALUES (?, ?, ?, ?, ?)',
        [logId, userId, handlerId, amount, new Date().toISOString()]
    );

    return jsonResponse({
        success: true,
        message: `✅ 打赏成功！赠送 ${amount} 红钻给 ${handler.username}`
    });
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

    if (order.boss_id !== userId && order.handler_id !== userId && order.dispatcher_id !== userId && user.role !== 'admin') {
        return errorResponse('无权操作', 403);
    }

    const sender = user.role === 'boss' ? 'boss' : user.role === 'handler' ? 'handler' : user.role === 'dispatcher' ? 'dispatcher' : 'admin';
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
    if (user.role !== 'handler' && user.role !== 'dispatcher') return errorResponse('该用户不是打手或派单员');
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
//  派单员获取自己的订单
// ============================================================

async function handleDispatcherGetOrders(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || user.role !== 'dispatcher') return errorResponse('无权限', 403);

    const result = await queryDB(env,
        'SELECT * FROM orders WHERE dispatcher_id = ? ORDER BY created_at DESC',
        [userId]
    );
    return jsonResponse(result.results || []);
}

async function handleDispatcherGetStats(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || user.role !== 'dispatcher') return errorResponse('无权限', 403);

    const orders = await queryDB(env,
        'SELECT * FROM orders WHERE dispatcher_id = ?',
        [userId]
    );
    const list = orders.results || [];
    const total = list.length;
    const pending = list.filter(o => o.status === 'pending').length;
    const ongoing = list.filter(o => o.status === 'ongoing').length;
    const completed = list.filter(o => o.status === 'completed').length;

    return jsonResponse({
        total: total,
        pending: pending,
        ongoing: ongoing,
        completed: completed
    });
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

        // ===== 公开接口 =====
        if (path === '/api/register' && method === 'POST') {
            return await handleRegister(env, body, request);
        }
        if (path === '/api/login' && method === 'POST') {
            return await handleLogin(env, body, request);
        }
        if (path === '/api/products' && method === 'GET') {
            return await handleGetProducts(env);
        }
        if (path === '/api/announce' && method === 'GET') {
            return await handleGetAnnounce(env);
        }
        if (path === '/api/handlers' && method === 'GET') {
            return await handleGetAvailableHandlers(env);
        }
        if (path.startsWith('/api/products/') && method === 'GET') {
            const productId = path.replace('/api/products/', '');
            return await handleGetProductDetail(env, productId);
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
        if (path === '/api/tip' && method === 'POST') {
            return await handleTip(env, authHeader, body);
        }

        // ===== 派单员接口 =====
        if (path === '/api/dispatcher/orders' && method === 'GET') {
            return await handleDispatcherGetOrders(env, authHeader);
        }
        if (path === '/api/dispatcher/stats' && method === 'GET') {
            return await handleDispatcherGetStats(env, authHeader);
        }
        if (path === '/api/dispatcher/publish' && method === 'POST') {
            return await handleDirectPublish(env, authHeader, body);
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
            if (orderId.endsWith('/chat') && method === 'POST') {
                const id = orderId.replace('/chat', '');
                return await handleSendChat(env, authHeader, id, body);
            }
            if (orderId.endsWith('/cancel') && method === 'PUT') {
                const id = orderId.replace('/cancel', '');
                return await handleCancelOrder(env, authHeader, id, body);
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
                    return await handleDirectPublish(env, authHeader, body);
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

                // 商品管理
                if (path === '/api/admin/products' && method === 'GET') {
                    return await handleAdminGetProducts(env);
                }
                if (path === '/api/admin/products' && method === 'POST') {
                    return await handleAdminCreateProduct(env, body);
                }
                if (path.startsWith('/api/admin/products/')) {
                    const productId = path.replace('/api/admin/products/', '');
                    if (productId.endsWith('/unshelf') && method === 'PUT') {
                        const id = productId.replace('/unshelf', '');
                        return await handleAdminUnshelf(env, id);
                    }
                    if (productId.endsWith('/reshelf') && method === 'PUT') {
                        const id = productId.replace('/reshelf', '');
                        return await handleAdminReshelf(env, id);
                    }
                    if (productId.endsWith('/edit') && method === 'PUT') {
                        const id = productId.replace('/edit', '');
                        return await handleAdminUpdateProduct(env, id, body);
                    }
                    if (method === 'DELETE') {
                        return await handleAdminDeleteProduct(env, productId);
                    }
                }

                // 充值管理
                if (path === '/api/admin/recharges' && method === 'GET') {
                    return await handleAdminGetRecharges(env);
                }
                if (path === '/api/admin/recharges/pending-count' && method === 'GET') {
                    return await handleAdminGetRechargePendingCount(env);
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
                if (path === '/api/admin/users/pending-count' && method === 'GET') {
                    return await handleAdminGetUserPendingCount(env);
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