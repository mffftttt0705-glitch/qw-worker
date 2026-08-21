// ============================================================
//  QW电竞 - 完整后端 API（Pages Functions 版本）
//  功能：店长入驻 + 店铺创建申请 + 管理员审核
// ============================================================

// ===== IP注册缓存 =====
const registerCache = {};

function cleanRegisterCache(ip) {
    const now = Date.now();
    if (registerCache[ip]) {
        registerCache[ip] = registerCache[ip].filter(time => now - time < 3600000);
        if (registerCache[ip].length === 0) {
            delete registerCache[ip];
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

function verifyAndGetUserId(authHeader) {
    if (!authHeader) return null;
    const parts = authHeader.split('.');
    if (parts.length !== 2) return null;
    return parts[1];
}

async function getUserById(env, userId) {
    const result = await queryDB(env, 'SELECT * FROM users WHERE id = ?', [userId]);
    return (result.results && result.results[0]) || null;
}

async function getShopById(env, shopId) {
    const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
    return (result.results && result.results[0]) || null;
}

function hasAdminPermission(user) {
    return user.is_admin === 1;
}

function hasShopOwnerPermission(user) {
    return user.role === 'shop_owner' || user.is_shop_admin === 1 || user.is_admin === 1;
}

// ============================================================
//  1. 注册功能（店长不需要邀请码）
// ============================================================

async function handleRegister(env, body, request) {
    const { username, password, role, status, phone, invite_code, shop_name } = body;
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

    // ===== 店长入驻：不需要邀请码 =====
    if (role === 'shop_owner') {
        if (!shop_name) return errorResponse('请填写俱乐部名称');
        // 检查俱乐部名称是否已被使用
        const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ?', [shop_name]);
        if (nameCheck.results && nameCheck.results.length > 0) {
            return errorResponse('该俱乐部名称已被使用');
        }
    }

    // ===== 老板/打手：需要邀请码 =====
    if (role !== 'shop_owner') {
        if (!invite_code) {
            return errorResponse('请填写店铺邀请码');
        }
        const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ? AND status = "active"', [invite_code]);
        const shop = (shopResult.results && shopResult.results[0]) || null;
        if (!shop) {
            return errorResponse('邀请码无效或店铺已停用');
        }
    }

    const id = generateId();
    const userStatus = (role === 'handler' || role === 'shop_owner') ? 'pending' : (status || 'active');

    // 构建插入语句
    let sql = `INSERT INTO users (id, username, password, role, diamond, balance, status, phone, register_ip, created_at, is_admin, is_shop_admin) 
               VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, 0, 0)`;
    let params = [id, username, password, role || 'boss', userStatus, phone || '', clientIP, new Date().toISOString()];

    // 如果是老板/打手，设置 shop_id 和 shop_name
    if (role !== 'shop_owner') {
        const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ? AND status = "active"', [invite_code]);
        const shop = (shopResult.results && shopResult.results[0]) || null;
        if (shop) {
            sql = `INSERT INTO users (id, username, password, role, diamond, balance, status, phone, register_ip, created_at, shop_id, shop_name, invite_code, is_admin, is_shop_admin) 
                   VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0, 0)`;
            params = [id, username, password, role || 'boss', userStatus, phone || '', clientIP, new Date().toISOString(), shop.id, shop.name, invite_code];
        }
    }

    await runDB(env, sql, params);

    if (!registerCache[clientIP]) {
        registerCache[clientIP] = [];
    }
    registerCache[clientIP].push(Date.now());

    return jsonResponse({
        message: '注册成功',
        id,
        needApproval: role === 'shop_owner' || role === 'handler'
    });
}

// ============================================================
//  2. 登录功能
// ============================================================

async function handleLogin(env, body) {
    const { username, password } = body;
    if (!username || !password) return errorResponse('请填写用户名和密码');

    const result = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
    const user = (result.results && result.results[0]) || null;
    if (!user) return errorResponse('用户不存在');
    if (user.password !== password) return errorResponse('密码错误');
    if (user.status === 'banned') return errorResponse('账号已被封禁');
    if (user.status === 'pending') return errorResponse('账号待审核');

    const token = generateId() + '.' + user.id;

    let shop = null;
    if (user.shop_id) {
        const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [user.shop_id]);
        shop = (shopResult.results && shopResult.results[0]) || null;
        if (shop && shop.status === 'banned') {
            return errorResponse('店铺已被封禁，请联系管理员');
        }
    }

    return jsonResponse({
        token,
        user: {
            id: user.id,
            username: user.username,
            role: user.role || 'boss',
            diamond: user.diamond || 0,
            balance: user.balance || 0,
            status: user.status || 'active',
            shop_id: user.shop_id || null,
            shop_name: user.shop_name || null,
            is_admin: user.is_admin || 0,
            is_shop_admin: user.is_shop_admin || 0
        },
        shop: shop
    });
}

async function handleGetMe(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    let shop = null;
    if (user.shop_id) {
        const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [user.shop_id]);
        shop = (shopResult.results && shopResult.results[0]) || null;
    }

    const { password, ...rest } = user;
    return jsonResponse({ ...rest, shop });
}

// ============================================================
//  3. 店长 - 申请创建店铺
// ============================================================

async function handleShopCreateApply(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    // 只有店长可以申请创建店铺
    if (user.role !== 'shop_owner') {
        return errorResponse('只有店长可以申请创建店铺', 403);
    }

    // 检查是否已有店铺
    if (user.shop_id) {
        return errorResponse('您已拥有店铺，不能重复创建', 400);
    }

    const { shop_name, invite_code } = body;
    if (!shop_name || !invite_code) {
        return errorResponse('请填写俱乐部名称和邀请码', 400);
    }
    if (invite_code.length < 4) {
        return errorResponse('邀请码至少4位字符', 400);
    }

    // 检查俱乐部名称
    const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ?', [shop_name]);
    if (nameCheck.results && nameCheck.results.length > 0) {
        return errorResponse('该俱乐部名称已被使用', 400);
    }

    // 检查邀请码
    const codeCheck = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ?', [invite_code]);
    if (codeCheck.results && codeCheck.results.length > 0) {
        return errorResponse('该邀请码已被使用', 400);
    }

    // 检查是否已有待审核的申请
    const pendingCheck = await queryDB(env, 
        'SELECT * FROM shop_create_applications WHERE applicant_id = ? AND status = "pending"', 
        [userId]
    );
    if (pendingCheck.results && pendingCheck.results.length > 0) {
        return errorResponse('您已提交过申请，请等待管理员审核', 400);
    }

    const id = generateId();
    await runDB(env,
        `INSERT INTO shop_create_applications (id, shop_name, invite_code, applicant_id, applicant_name, status, created_at) 
         VALUES (?, ?, ?, ?, ?, "pending", ?)`,
        [id, shop_name, invite_code, userId, user.username, new Date().toISOString()]
    );

    return jsonResponse({ 
        success: true, 
        message: '✅ 店铺创建申请已提交，请等待管理员审核',
        application_id: id
    });
}

// ============================================================
//  4. 管理员 - 获取店铺创建申请列表
// ============================================================

async function handleAdminGetShopCreateApplications(env) {
    const result = await queryDB(env, `
        SELECT a.*, u.username as applicant_name
        FROM shop_create_applications a
        LEFT JOIN users u ON a.applicant_id = u.id
        ORDER BY a.created_at DESC
    `);
    return jsonResponse(result.results || []);
}

// ============================================================
//  5. 管理员 - 审核店铺创建申请
// ============================================================

async function handleAdminApproveShopCreate(env, applicationId) {
    const appResult = await queryDB(env, 'SELECT * FROM shop_create_applications WHERE id = ?', [applicationId]);
    const app = (appResult.results && appResult.results[0]) || null;
    if (!app) return errorResponse('申请不存在', 404);
    if (app.status !== 'pending') return errorResponse('已处理');

    // 检查用户是否存在
    const user = await getUserById(env, app.applicant_id);
    if (!user) return errorResponse('申请人不存在', 404);
    if (user.role !== 'shop_owner') return errorResponse('申请人不是店长', 400);

    // 检查是否已有店铺
    if (user.shop_id) {
        await runDB(env, 'DELETE FROM shop_create_applications WHERE id = ?', [applicationId]);
        return errorResponse('该用户已拥有店铺', 400);
    }

    // 检查俱乐部名称
    const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ?', [app.shop_name]);
    if (nameCheck.results && nameCheck.results.length > 0) {
        await runDB(env, 'DELETE FROM shop_create_applications WHERE id = ?', [applicationId]);
        return errorResponse('该俱乐部名称已被使用', 400);
    }

    // 检查邀请码
    const codeCheck = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ?', [app.invite_code]);
    if (codeCheck.results && codeCheck.results.length > 0) {
        await runDB(env, 'DELETE FROM shop_create_applications WHERE id = ?', [applicationId]);
        return errorResponse('该邀请码已被使用', 400);
    }

    // 创建店铺
    const shopId = generateId();
    await runDB(env,
        `INSERT INTO shops (id, name, owner_id, invite_code, status, dispatch_to_all, managers, created_at, apply_time, review_time) 
         VALUES (?, ?, ?, ?, "active", 1, ?, ?, ?, ?)`,
        [shopId, app.shop_name, app.applicant_id, app.invite_code, app.applicant_id, app.created_at, new Date().toISOString()]
    );

    // 更新用户的 shop_id 和 shop_name
    await runDB(env, 'UPDATE users SET shop_id = ?, shop_name = ?, is_shop_admin = 1 WHERE id = ?', 
        [shopId, app.shop_name, app.applicant_id]);

    // 更新申请状态
    await runDB(env, 'UPDATE shop_create_applications SET status = "approved", reviewed_at = ? WHERE id = ?',
        [new Date().toISOString(), applicationId]);

    return jsonResponse({ 
        success: true, 
        message: '✅ 店铺创建审核通过',
        shop_id: shopId,
        shop_name: app.shop_name
    });
}

async function handleAdminRejectShopCreate(env, applicationId) {
    const appResult = await queryDB(env, 'SELECT * FROM shop_create_applications WHERE id = ?', [applicationId]);
    const app = (appResult.results && appResult.results[0]) || null;
    if (!app) return errorResponse('申请不存在', 404);
    if (app.status !== 'pending') return errorResponse('已处理');

    await runDB(env, 'UPDATE shop_create_applications SET status = "rejected", reviewed_at = ? WHERE id = ?',
        [new Date().toISOString(), applicationId]);

    return jsonResponse({ success: true, message: '已拒绝' });
}

// ============================================================
//  6. 店长 - 获取自己的店铺创建申请状态
// ============================================================

async function handleShopGetCreateStatus(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    // 如果已有店铺，返回已有店铺
    if (user.shop_id) {
        const shop = await getShopById(env, user.shop_id);
        return jsonResponse({
            hasShop: true,
            shop: shop,
            status: 'active'
        });
    }

    // 检查是否有待审核的申请
    const pendingResult = await queryDB(env,
        'SELECT * FROM shop_create_applications WHERE applicant_id = ? AND status = "pending" ORDER BY created_at DESC LIMIT 1',
        [userId]
    );
    if (pendingResult.results && pendingResult.results.length > 0) {
        return jsonResponse({
            hasShop: false,
            status: 'pending',
            application: pendingResult.results[0]
        });
    }

    // 检查是否有被拒绝的申请
    const rejectedResult = await queryDB(env,
        'SELECT * FROM shop_create_applications WHERE applicant_id = ? AND status = "rejected" ORDER BY created_at DESC LIMIT 1',
        [userId]
    );
    if (rejectedResult.results && rejectedResult.results.length > 0) {
        return jsonResponse({
            hasShop: false,
            status: 'rejected',
            application: rejectedResult.results[0]
        });
    }

    return jsonResponse({
        hasShop: false,
        status: 'none'
    });
}

// ============================================================
//  7. 管理员 - 其他接口（店铺管理、用户管理等）
// ============================================================

async function handleAdminGetShops(env) {
    const result = await queryDB(env, `
        SELECT s.*, u.username as owner_name, u.status as owner_status
        FROM shops s 
        LEFT JOIN users u ON s.owner_id = u.id 
        ORDER BY s.created_at DESC
    `);
    return jsonResponse(result.results || []);
}

async function handleAdminToggleShop(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const newStatus = shop.status === 'active' ? 'banned' : 'active';
    await runDB(env, 'UPDATE shops SET status = ? WHERE id = ?', [newStatus, shopId]);

    if (shop.owner_id) {
        const ownerStatus = newStatus === 'active' ? 'active' : 'banned';
        await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [ownerStatus, shop.owner_id]);
    }

    if (newStatus === 'banned') {
        await runDB(env, 'UPDATE users SET status = "banned" WHERE shop_id = ? AND role != "shop_owner"', [shopId]);
    } else {
        await runDB(env, 'UPDATE users SET status = "active" WHERE shop_id = ? AND role != "shop_owner" AND status != "banned"', [shopId]);
    }

    return jsonResponse({ success: true, message: `店铺已${newStatus === 'active' ? '解封' : '封禁'}` });
}

async function handleAdminSetDispatch(env, shopId, body) {
    const { dispatch_to_all } = body;
    if (typeof dispatch_to_all !== 'number' || (dispatch_to_all !== 0 && dispatch_to_all !== 1)) {
        return errorResponse('参数错误，请传入 0 或 1');
    }

    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    await runDB(env, 'UPDATE shops SET dispatch_to_all = ? WHERE id = ?', [dispatch_to_all, shopId]);

    return jsonResponse({
        success: true,
        message: dispatch_to_all === 1 ? '订单已分发到全部打手' : '订单仅本店打手可见',
        dispatch_to_all: dispatch_to_all
    });
}

// ============================================================
//  8. 店铺信息更新
// ============================================================

async function handleUpdateShopInfo(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    if (!hasAdminPermission(user) && user.is_shop_admin !== 1) {
        return errorResponse('无权限', 403);
    }

    const { shop_id, new_name, new_invite_code } = body;
    if (!shop_id) return errorResponse('请提供店铺ID', 400);

    const shop = await getShopById(env, shop_id);
    if (!shop) return errorResponse('店铺不存在', 404);

    if (!hasAdminPermission(user) && shop.owner_id !== userId) {
        return errorResponse('无权修改此店铺', 403);
    }

    if (new_name && new_name.trim()) {
        const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ? AND id != ?', [new_name.trim(), shop_id]);
        if (nameCheck.results && nameCheck.results.length > 0) {
            return errorResponse('该俱乐部名称已被使用', 400);
        }
        await runDB(env, 'UPDATE shops SET name = ? WHERE id = ?', [new_name.trim(), shop_id]);
        await runDB(env, 'UPDATE users SET shop_name = ? WHERE shop_id = ?', [new_name.trim(), shop_id]);
    }

    if (new_invite_code && new_invite_code.trim()) {
        if (new_invite_code.trim().length < 4) {
            return errorResponse('邀请码至少4位字符', 400);
        }
        const codeCheck = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ? AND id != ?', [new_invite_code.trim(), shop_id]);
        if (codeCheck.results && codeCheck.results.length > 0) {
            return errorResponse('该邀请码已被使用', 400);
        }
        await runDB(env, 'UPDATE shops SET invite_code = ? WHERE id = ?', [new_invite_code.trim(), shop_id]);
        await runDB(env, 'UPDATE users SET invite_code = ? WHERE shop_id = ?', [new_invite_code.trim(), shop_id]);
    }

    return jsonResponse({
        success: true,
        message: '店铺信息已更新'
    });
}

// ============================================================
//  9. 商品获取
// ============================================================

async function handleGetProducts(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    let shopId = null;

    if (userId) {
        const user = await getUserById(env, userId);
        if (user && user.shop_id) {
            shopId = user.shop_id;
        }
    }

    if (!shopId) {
        const result = await queryDB(env,
            'SELECT * FROM products WHERE hidden = 0 AND shop_id = "shop_platform" ORDER BY created_at DESC'
        );
        return jsonResponse(result.results || []);
    }

    const result = await queryDB(env,
        'SELECT * FROM products WHERE hidden = 0 AND shop_id = ? ORDER BY created_at DESC',
        [shopId]
    );
    return jsonResponse(result.results || []);
}

// ============================================================
//  10. 打手获取待接单列表
// ============================================================

async function handleGetHandlerOrders(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || user.role !== 'handler') return errorResponse('只有打手可查看', 403);

    const { filter_type } = body || {};

    let sql = 'SELECT * FROM orders WHERE status = "pending"';
    const params = [];

    if (filter_type === 'shop' && user.shop_id) {
        sql += ' AND shop_id = ?';
        params.push(user.shop_id);
    } else {
        sql += ` AND (
            shop_id = "shop_platform" 
            OR shop_id IN (SELECT id FROM shops WHERE dispatch_to_all = 1 AND status = "active")
        )`;
    }

    sql += ' ORDER BY created_at DESC';
    const result = await queryDB(env, sql, params);
    return jsonResponse(result.results || []);
}

// ============================================================
//  11. 购买商品
// ============================================================

async function handleBuyProduct(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);

    const { productId } = body;
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
    const shopId = product.shop_id || 'shop_platform';

    await runDB(env,
        `INSERT INTO orders (id, product_id, boss_id, status, price, game, title, description, messages, shop_id) 
         VALUES (?, ?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
        [orderId, productId, userId, product.price, product.game, product.title, product.desc || '',
            JSON.stringify([{ sender: 'system', content: '🎉 订单已创建', time: new Date().toISOString() }]),
            shopId
        ]
    );

    await runDB(env, 'UPDATE products SET sold = sold + 1 WHERE id = ?', [productId]);
    return jsonResponse({ orderId, message: '购买成功' });
}

// ============================================================
//  12. 我的订单
// ============================================================

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
        let pendingSql = 'SELECT * FROM orders WHERE status = "pending"';
        let pendingParams = [];

        if (user.shop_id) {
            pendingSql += ` AND (
                shop_id = ? 
                OR shop_id = "shop_platform" 
                OR shop_id IN (SELECT id FROM shops WHERE dispatch_to_all = 1 AND status = "active")
            )`;
            pendingParams.push(user.shop_id);
        } else {
            pendingSql += ' AND shop_id = "shop_platform"';
        }

        const pendingResult = await queryDB(env, pendingSql + ' ORDER BY created_at DESC', pendingParams);
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

    const result = await queryDB(env, sql, params);
    return jsonResponse(result.results || []);
}

// ============================================================
//  13. 聊天
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
//  14. 管理员 - 获取店铺独立数据
// ============================================================

async function handleAdminGetShopDashboard(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const orders = await queryDB(env, 'SELECT * FROM orders WHERE shop_id = ? ORDER BY created_at DESC', [shopId]);
    const users = await queryDB(env, 'SELECT * FROM users WHERE shop_id = ?', [shopId]);
    const products = await queryDB(env, 'SELECT * FROM products WHERE shop_id = ?', [shopId]);

    const totalOrders = orders.results ? orders.results.length : 0;
    const pendingOrders = orders.results ? orders.results.filter(o => o.status === 'pending').length : 0;
    const totalUsers = users.results ? users.results.length : 0;
    const totalProducts = products.results ? products.results.length : 0;

    return jsonResponse({
        shop: shop,
        stats: {
            totalOrders: totalOrders,
            pendingOrders: pendingOrders,
            totalUsers: totalUsers,
            totalProducts: totalProducts
        },
        recentOrders: orders.results ? orders.results.slice(0, 10) : []
    });
}

async function handleAdminGetShopProducts(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const result = await queryDB(env,
        'SELECT * FROM products WHERE shop_id = ? ORDER BY created_at DESC',
        [shopId]
    );
    return jsonResponse(result.results || []);
}

async function handleAdminGetShopOrders(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const result = await queryDB(env,
        'SELECT * FROM orders WHERE shop_id = ? ORDER BY created_at DESC',
        [shopId]
    );
    return jsonResponse(result.results || []);
}

async function handleAdminGetShopUsers(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const result = await queryDB(env,
        'SELECT id, username, role, diamond, balance, status FROM users WHERE shop_id = ?',
        [shopId]
    );
    return jsonResponse(result.results || []);
}

async function handleAdminGetShopRecharges(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const result = await queryDB(env,
        'SELECT * FROM recharges WHERE shop_id = ? ORDER BY created_at DESC',
        [shopId]
    );
    return jsonResponse(result.results || []);
}

async function handleAdminGetShopAnnounce(env, shopId) {
    const shop = await getShopById(env, shopId);
    if (!shop) return errorResponse('店铺不存在', 404);

    const result = await queryDB(env,
        'SELECT * FROM announces WHERE shop_id = ? ORDER BY updated_at DESC LIMIT 1',
        [shopId]
    );
    const data = (result.results && result.results[0]) || { content: '暂无公告', images: '[]' };
    if (typeof data.images === 'string') {
        try { data.images = JSON.parse(data.images); } catch (e) { data.images = []; }
    }
    return jsonResponse(data);
}

async function handleAdminUpdateShopAnnounce(env, shopId, body) {
    const { content, images } = body;
    await runDB(env, 'DELETE FROM announces WHERE shop_id = ?', [shopId]);
    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
    await runDB(env,
        'INSERT INTO announces (id, content, images, updated_at, shop_id) VALUES (?, ?, ?, ?, ?)',
        [generateId(), content || '欢迎来到我们的俱乐部！', imagesJson, new Date().toISOString(), shopId]
    );
    return jsonResponse({ success: true, message: '公告已更新' });
}

async function handleAdminCreateShopProduct(env, shopId, body) {
    const { game, title, desc, price, quantity, image } = body;
    if (!title || !price) return errorResponse('请填写完整信息');

    const id = generateId();
    await runDB(env,
        `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, shop_id) 
         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
        [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', shopId]
    );
    return jsonResponse({ success: true, id });
}

async function handleAdminPublishShopOrder(env, shopId, body) {
    const { game, title, desc, price } = body;
    if (!title || !price) return errorResponse('请填写完整信息');

    const orderId = generateId();
    await runDB(env,
        `INSERT INTO orders (id, boss_id, status, price, game, title, description, messages, shop_id) 
         VALUES (?, "admin_platform", "pending", ?, ?, ?, ?, ?, ?)`,
        [orderId, parseFloat(price), game || '暗区突围', title, desc || '',
            JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（管理员发布）', time: new Date().toISOString() }]),
            shopId
        ]
    );
    return jsonResponse({ success: true, orderId });
}

// ============================================================
//  15. 管理员 - 原有的其他接口
// ============================================================

async function handleAdminGetOrders(env) {
    const result = await queryDB(env, 'SELECT * FROM orders ORDER BY created_at DESC');
    return jsonResponse(result.results || []);
}

async function handleAdminGetUsers(env) {
    const result = await queryDB(env, 'SELECT id, username, role, diamond, balance, status, shop_name FROM users');
    return jsonResponse(result.results || []);
}

async function handleAdminGetRecharges(env) {
    const result = await queryDB(env, 'SELECT * FROM recharges ORDER BY created_at DESC');
    return jsonResponse(result.results || []);
}

async function handleAdminGift(env, body) {
    const { targetUserId, amount } = body;
    if (!targetUserId || !amount) return errorResponse('请填写完整信息');
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [amount, targetUserId]);
    return jsonResponse({ success: true, message: '赠送成功' });
}

async function handleAdminApproveRecharge(env, rechargeId) {
    const result = await queryDB(env, 'SELECT * FROM recharges WHERE id = ?', [rechargeId]);
    const recharge = (result.results && result.results[0]) || null;
    if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
    await runDB(env, 'UPDATE recharges SET status = "approved", approve_time = ? WHERE id = ?',
        [new Date().toISOString(), rechargeId]);
    if (recharge.user_id) {
        await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond || 0, recharge.user_id]);
    }
    return jsonResponse({ success: true, message: '审核通过，红钻已到账' });
}

async function handleAdminRejectRecharge(env, rechargeId) {
    await runDB(env, 'UPDATE recharges SET status = "rejected", approve_time = ? WHERE id = ?',
        [new Date().toISOString(), rechargeId]);
    return jsonResponse({ success: true, message: '已拒绝' });
}

async function handleAdminDeleteRecharge(env, rechargeId) {
    await runDB(env, 'DELETE FROM recharges WHERE id = ?', [rechargeId]);
    return jsonResponse({ success: true, message: '已删除' });
}

async function handleAdminToggleUserBan(env, userId) {
    const target = await getUserById(env, userId);
    if (!target) return errorResponse('用户不存在', 404);
    const newStatus = target.status === 'active' ? 'banned' : 'active';
    await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, userId]);
    return jsonResponse({ success: true, message: '用户状态已更新' });
}

async function handleAdminResetPassword(env, userId) {
    await runDB(env, 'UPDATE users SET password = "123456" WHERE id = ?', [userId]);
    return jsonResponse({ success: true, message: '密码已重置为 123456' });
}

async function handleAdminApproveHandler(env, userId) {
    await runDB(env, 'UPDATE users SET status = "active" WHERE id = ?', [userId]);
    return jsonResponse({ success: true, message: '打手审核通过' });
}

async function handleAdminToggleShopOwner(env, userId) {
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);
    if (user.role !== 'shop_owner') return errorResponse('该用户不是店长');

    const newStatus = user.status === 'active' ? 'banned' : 'active';
    await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, userId]);

    if (user.shop_id) {
        const shopStatus = newStatus === 'active' ? 'active' : 'banned';
        await runDB(env, 'UPDATE shops SET status = ? WHERE id = ?', [shopStatus, user.shop_id]);
    }

    return jsonResponse({ success: true, message: `店长已${newStatus === 'active' ? '解封' : '封禁'}` });
}

// ============================================================
//  16. 管理员 - 订单操作
// ============================================================

async function handleAdminAssignHandler(env, orderId, body) {
    const { handlerId } = body;
    if (!handlerId) return errorResponse('请选择打手');
    await runDB(env, 'UPDATE orders SET handler_id = ?, status = "ongoing", start_time = ? WHERE id = ?',
        [handlerId, new Date().toISOString(), orderId]);
    return jsonResponse({ success: true, message: '指派成功' });
}

async function handleAdminForceComplete(env, orderId) {
    await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
        [new Date().toISOString(), orderId]);
    return jsonResponse({ success: true, message: '强制完成成功' });
}

async function handleAdminConfirmComplete(env, orderId) {
    await runDB(env, 'UPDATE orders SET status = "completed", end_time = ? WHERE id = ?',
        [new Date().toISOString(), orderId]);
    return jsonResponse({ success: true, message: '验收通过' });
}

async function handleAdminRejectOrder(env, orderId, body) {
    const { reason } = body;
    await runDB(env, 'UPDATE orders SET status = "rejected", refund_reason = ? WHERE id = ?',
        [reason || '无原因', orderId]);
    return jsonResponse({ success: true, message: '已驳回' });
}

async function handleAdminCancelOrder(env, orderId) {
    const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
    const order = (result.results && result.results[0]) || null;
    await runDB(env, 'UPDATE orders SET status = "canceled" WHERE id = ?', [orderId]);
    if (order && order.boss_id) {
        await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price * 10, order.boss_id]);
    }
    return jsonResponse({ success: true, message: '已取消' });
}

async function handleAdminSettleOrder(env, orderId, body) {
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

async function handleAdminRefundOrder(env, orderId, body) {
    const { approve } = body;
    if (approve) {
        const result = await queryDB(env, 'SELECT * FROM orders WHERE id = ?', [orderId]);
        const order = (result.results && result.results[0]) || null;
        await runDB(env, 'UPDATE orders SET status = "refunded" WHERE id = ?', [orderId]);
        if (order && order.boss_id) {
            await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [order.price * 10, order.boss_id]);
        }
        return jsonResponse({ success: true, message: '退款已通过' });
    } else {
        const { rejectReason } = body;
        await runDB(env, 'UPDATE orders SET status = "ongoing", refund_reason = ? WHERE id = ?',
            [rejectReason || '退款被拒绝', orderId]);
        return jsonResponse({ success: true, message: '退款已拒绝' });
    }
}

async function handleAdminDeleteOrder(env, orderId) {
    await runDB(env, 'DELETE FROM orders WHERE id = ?', [orderId]);
    return jsonResponse({ success: true, message: '已删除' });
}

// ============================================================
//  17. 管理员 - 商品操作
// ============================================================

async function handleAdminGetProducts(env) {
    const result = await queryDB(env, 'SELECT * FROM products ORDER BY created_at DESC');
    return jsonResponse(result.results || []);
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

async function handleAdminAnnounce(env, body) {
    const { content, images } = body;
    await runDB(env, 'DELETE FROM announces WHERE shop_id = "shop_platform"');
    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
    await runDB(env,
        'INSERT INTO announces (id, content, images, updated_at, shop_id) VALUES (?, ?, ?, ?, "shop_platform")',
        [generateId(), content || '欢迎使用 QW电竞护航平台！', imagesJson, new Date().toISOString()]
    );
    return jsonResponse({ success: true, message: '公告已更新' });
}

async function handleGetAnnounce(env) {
    const result = await queryDB(env, 'SELECT * FROM announces WHERE shop_id = "shop_platform" ORDER BY updated_at DESC LIMIT 1');
    const data = (result.results && result.results[0]) || { content: '欢迎使用 QW电竞护航平台！', images: '[]' };
    if (typeof data.images === 'string') {
        try { data.images = JSON.parse(data.images); } catch (e) { data.images = []; }
    }
    return jsonResponse(data);
}

// ============================================================
//  18. Pages Functions 入口
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
        const userId = verifyAndGetUserId(authHeader);

        // ===== 公开接口 =====
        if (path === '/api/register' && method === 'POST') {
            return await handleRegister(env, body, request);
        }
        if (path === '/api/login' && method === 'POST') {
            return await handleLogin(env, body);
        }
        if (path === '/api/products' && method === 'GET') {
            return await handleGetProducts(env, authHeader);
        }
        if (path === '/api/announce' && method === 'GET') {
            return await handleGetAnnounce(env);
        }

        // ===== 需要登录的接口 =====
        if (path === '/api/me' && method === 'GET') {
            return await handleGetMe(env, authHeader);
        }
        if (path === '/api/orders/pending' && method === 'POST') {
            return await handleGetHandlerOrders(env, authHeader, body);
        }
        if (path === '/api/orders/buy' && method === 'POST') {
            return await handleBuyProduct(env, authHeader, body);
        }
        if (path === '/api/orders/my' && method === 'GET') {
            return await handleGetMyOrders(env, authHeader);
        }

        // ===== 聊天接口 =====
        if (path.startsWith('/api/orders/') && path.endsWith('/chat') && method === 'POST') {
            const orderId = path.replace('/api/orders/', '').replace('/chat', '');
            return await handleSendChat(env, authHeader, orderId, body);
        }

        // ===== 店长 - 申请创建店铺 =====
        if (path === '/api/shop/create-apply' && method === 'POST') {
            return await handleShopCreateApply(env, authHeader, body);
        }

        // ===== 店长 - 获取创建状态 =====
        if (path === '/api/shop/create-status' && method === 'GET') {
            return await handleShopGetCreateStatus(env, authHeader);
        }

        // ===== 店长 - 店铺信息更新 =====
        if (path === '/api/shop/update' && method === 'POST') {
            return await handleUpdateShopInfo(env, authHeader, body);
        }

        // ===== 店长/管理员 - 店铺管理接口 =====
        if (userId) {
            const user = await getUserById(env, userId);
            if (user && hasShopOwnerPermission(user)) {
                if (path === '/api/shop/owner/info' && method === 'GET') {
                    const shop = await getShopById(env, user.shop_id);
                    return jsonResponse(shop || null);
                }
                if (path === '/api/shop/owner/products' && method === 'GET') {
                    const result = await queryDB(env, 'SELECT * FROM products WHERE shop_id = ? ORDER BY created_at DESC', [user.shop_id]);
                    return jsonResponse(result.results || []);
                }
                if (path === '/api/shop/owner/products' && method === 'POST') {
                    const { game, title, desc, price, quantity, image } = body;
                    if (!title || !price) return errorResponse('请填写完整信息');
                    const id = generateId();
                    await runDB(env,
                        `INSERT INTO products (id, game, title, description, price, quantity, sold, hidden, image, shop_id) 
                         VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)`,
                        [id, game || '暗区突围', title, desc || '', parseFloat(price), parseInt(quantity) || 1, image || '', user.shop_id]
                    );
                    return jsonResponse({ success: true, id });
                }
                if (path.startsWith('/api/shop/owner/products/')) {
                    const productId = path.replace('/api/shop/owner/products/', '');
                    if (productId.endsWith('/unshelf') && method === 'PUT') {
                        const id = productId.replace('/unshelf', '');
                        await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ? AND shop_id = ?', [id, user.shop_id]);
                        return jsonResponse({ success: true, message: '已下架' });
                    }
                    if (productId.endsWith('/reshelf') && method === 'PUT') {
                        const id = productId.replace('/reshelf', '');
                        await runDB(env, 'UPDATE products SET hidden = 0 WHERE id = ? AND shop_id = ?', [id, user.shop_id]);
                        return jsonResponse({ success: true, message: '已重新上架' });
                    }
                    if (method === 'DELETE') {
                        await runDB(env, 'DELETE FROM products WHERE id = ? AND shop_id = ?', [productId, user.shop_id]);
                        return jsonResponse({ success: true, message: '已删除' });
                    }
                }
                if (path === '/api/shop/owner/publish-order' && method === 'POST') {
                    const { game, title, desc, price } = body;
                    if (!title || !price) return errorResponse('请填写完整信息');
                    const orderId = generateId();
                    await runDB(env,
                        `INSERT INTO orders (id, boss_id, status, price, game, title, description, messages, shop_id) 
                         VALUES (?, ?, "pending", ?, ?, ?, ?, ?, ?)`,
                        [orderId, userId, parseFloat(price), game || '暗区突围', title, desc || '',
                            JSON.stringify([{ sender: 'system', content: '🎉 订单已创建（店长发布）', time: new Date().toISOString() }]),
                            user.shop_id
                        ]
                    );
                    return jsonResponse({ success: true, orderId });
                }
                if (path === '/api/shop/owner/orders' && method === 'GET') {
                    const result = await queryDB(env, 'SELECT * FROM orders WHERE shop_id = ? ORDER BY created_at DESC', [user.shop_id]);
                    return jsonResponse(result.results || []);
                }
                if (path === '/api/shop/owner/announce' && method === 'GET') {
                    const result = await queryDB(env, 'SELECT * FROM announces WHERE shop_id = ? ORDER BY updated_at DESC LIMIT 1', [user.shop_id]);
                    const data = (result.results && result.results[0]) || { content: '欢迎来到我们的俱乐部！', images: '[]' };
                    if (typeof data.images === 'string') {
                        try { data.images = JSON.parse(data.images); } catch (e) { data.images = []; }
                    }
                    return jsonResponse(data);
                }
                if (path === '/api/shop/owner/announce' && method === 'PUT') {
                    const { content, images } = body;
                    await runDB(env, 'DELETE FROM announces WHERE shop_id = ?', [user.shop_id]);
                    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
                    await runDB(env,
                        'INSERT INTO announces (id, content, images, updated_at, shop_id) VALUES (?, ?, ?, ?, ?)',
                        [generateId(), content || '欢迎来到我们的俱乐部！', imagesJson, new Date().toISOString(), user.shop_id]
                    );
                    return jsonResponse({ success: true, message: '公告已更新' });
                }
                if (path === '/api/shop/owner/users' && method === 'GET') {
                    const result = await queryDB(env,
                        'SELECT id, username, role, diamond, balance, status FROM users WHERE shop_id = ? AND id != ?',
                        [user.shop_id, userId]
                    );
                    return jsonResponse(result.results || []);
                }
                if (path.startsWith('/api/shop/owner/users/')) {
                    const targetUserId = path.replace('/api/shop/owner/users/', '');
                    if (targetUserId.endsWith('/ban') && method === 'PUT') {
                        const id = targetUserId.replace('/ban', '');
                        const target = await getUserById(env, id);
                        if (!target) return errorResponse('用户不存在', 404);
                        if (target.shop_id !== user.shop_id) return errorResponse('无权操作', 403);
                        const newStatus = target.status === 'active' ? 'banned' : 'active';
                        await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, id]);
                        return jsonResponse({ success: true, message: '用户状态已更新' });
                    }
                    if (targetUserId.endsWith('/reset-password') && method === 'PUT') {
                        const id = targetUserId.replace('/reset-password', '');
                        await runDB(env, 'UPDATE users SET password = "123456" WHERE id = ?', [id]);
                        return jsonResponse({ success: true, message: '密码已重置为 123456' });
                    }
                }
                if (path === '/api/shop/owner/recharges' && method === 'GET') {
                    const result = await queryDB(env, 'SELECT * FROM recharges WHERE shop_id = ? ORDER BY created_at DESC', [user.shop_id]);
                    return jsonResponse(result.results || []);
                }
                if (path.startsWith('/api/shop/owner/recharges/')) {
                    const rechargeId = path.replace('/api/shop/owner/recharges/', '');
                    if (rechargeId.endsWith('/approve') && method === 'PUT') {
                        const id = rechargeId.replace('/approve', '');
                        const shop = await getShopById(env, user.shop_id);
                        if (!shop) return errorResponse('店铺不存在', 404);
                        const rechargeResult = await queryDB(env, 'SELECT * FROM recharges WHERE id = ? AND shop_id = ?', [id, user.shop_id]);
                        const recharge = (rechargeResult.results && rechargeResult.results[0]) || null;
                        if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');
                        if (shop.diamond < recharge.diamond) return errorResponse('店铺红钻不足', 400);
                        await runDB(env, 'UPDATE shops SET diamond = diamond - ? WHERE id = ?', [recharge.diamond, shop.id]);
                        await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond, recharge.user_id]);
                        await runDB(env, 'UPDATE recharges SET status = "approved", approve_time = ? WHERE id = ?',
                            [new Date().toISOString(), id]);
                        return jsonResponse({ success: true, message: '充值通过，红钻已到账' });
                    }
                    if (rechargeId.endsWith('/reject') && method === 'PUT') {
                        const id = rechargeId.replace('/reject', '');
                        await runDB(env, 'UPDATE recharges SET status = "rejected", approve_time = ? WHERE id = ?',
                            [new Date().toISOString(), id]);
                        return jsonResponse({ success: true, message: '已拒绝' });
                    }
                }
            }

            // ===== 管理员接口 =====
            if (user && hasAdminPermission(user)) {
                // 店铺创建申请管理
                if (path === '/api/admin/shop-create-applications' && method === 'GET') {
                    return await handleAdminGetShopCreateApplications(env);
                }
                if (path.startsWith('/api/admin/shop-create-applications/')) {
                    const appId = path.replace('/api/admin/shop-create-applications/', '');
                    if (appId.endsWith('/approve') && method === 'PUT') {
                        const id = appId.replace('/approve', '');
                        return await handleAdminApproveShopCreate(env, id);
                    }
                    if (appId.endsWith('/reject') && method === 'PUT') {
                        const id = appId.replace('/reject', '');
                        return await handleAdminRejectShopCreate(env, id);
                    }
                }
                // 店铺管理
                if (path === '/api/admin/shops' && method === 'GET') {
                    return await handleAdminGetShops(env);
                }
                if (path.startsWith('/api/admin/shops/')) {
                    const shopId = path.replace('/api/admin/shops/', '');
                    if (shopId.endsWith('/toggle') && method === 'PUT') {
                        const id = shopId.replace('/toggle', '');
                        return await handleAdminToggleShop(env, id);
                    }
                    if (shopId.endsWith('/dispatch') && method === 'PUT') {
                        const id = shopId.replace('/dispatch', '');
                        return await handleAdminSetDispatch(env, id, body);
                    }
                    if (shopId.endsWith('/dashboard') && method === 'GET') {
                        const id = shopId.replace('/dashboard', '');
                        return await handleAdminGetShopDashboard(env, id);
                    }
                    if (shopId.endsWith('/products') && method === 'GET') {
                        const id = shopId.replace('/products', '');
                        return await handleAdminGetShopProducts(env, id);
                    }
                    if (shopId.endsWith('/orders') && method === 'GET') {
                        const id = shopId.replace('/orders', '');
                        return await handleAdminGetShopOrders(env, id);
                    }
                    if (shopId.endsWith('/users') && method === 'GET') {
                        const id = shopId.replace('/users', '');
                        return await handleAdminGetShopUsers(env, id);
                    }
                    if (shopId.endsWith('/recharges') && method === 'GET') {
                        const id = shopId.replace('/recharges', '');
                        return await handleAdminGetShopRecharges(env, id);
                    }
                    if (shopId.endsWith('/announce') && method === 'GET') {
                        const id = shopId.replace('/announce', '');
                        return await handleAdminGetShopAnnounce(env, id);
                    }
                    if (shopId.endsWith('/announce') && method === 'PUT') {
                        const id = shopId.replace('/announce', '');
                        return await handleAdminUpdateShopAnnounce(env, id, body);
                    }
                    if (shopId.endsWith('/create-product') && method === 'POST') {
                        const id = shopId.replace('/create-product', '');
                        return await handleAdminCreateShopProduct(env, id, body);
                    }
                    if (shopId.endsWith('/publish-order') && method === 'POST') {
                        const id = shopId.replace('/publish-order', '');
                        return await handleAdminPublishShopOrder(env, id, body);
                    }
                }
                // 其他管理员接口
                if (path === '/api/admin/orders' && method === 'GET') {
                    return await handleAdminGetOrders(env);
                }
                if (path === '/api/admin/users' && method === 'GET') {
                    return await handleAdminGetUsers(env);
                }
                if (path === '/api/admin/recharges' && method === 'GET') {
                    return await handleAdminGetRecharges(env);
                }
                if (path === '/api/admin/gift' && method === 'POST') {
                    return await handleAdminGift(env, body);
                }
                if (path === '/api/admin/announce' && method === 'PUT') {
                    return await handleAdminAnnounce(env, body);
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
                if (path.startsWith('/api/admin/users/')) {
                    const targetUserId = path.replace('/api/admin/users/', '');
                    if (targetUserId.endsWith('/ban') && method === 'PUT') {
                        const id = targetUserId.replace('/ban', '');
                        return await handleAdminToggleUserBan(env, id);
                    }
                    if (targetUserId.endsWith('/reset-password') && method === 'PUT') {
                        const id = targetUserId.replace('/reset-password', '');
                        return await handleAdminResetPassword(env, id);
                    }
                    if (targetUserId.endsWith('/approve') && method === 'PUT') {
                        const id = targetUserId.replace('/approve', '');
                        return await handleAdminApproveHandler(env, id);
                    }
                }
                if (path.startsWith('/api/admin/shop-owner/')) {
                    const targetUserId = path.replace('/api/admin/shop-owner/', '');
                    if (targetUserId.endsWith('/toggle') && method === 'PUT') {
                        const id = targetUserId.replace('/toggle', '');
                        return await handleAdminToggleShopOwner(env, id);
                    }
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
                        return await handleAdminConfirmComplete(env, id);
                    }
                    if (orderId.endsWith('/reject') && method === 'PUT') {
                        const id = orderId.replace('/reject', '');
                        return await handleAdminRejectOrder(env, id, body);
                    }
                    if (orderId.endsWith('/cancel') && method === 'PUT') {
                        const id = orderId.replace('/cancel', '');
                        return await handleAdminCancelOrder(env, id);
                    }
                    if (orderId.endsWith('/settle') && method === 'PUT') {
                        const id = orderId.replace('/settle', '');
                        return await handleAdminSettleOrder(env, id, body);
                    }
                    if (orderId.endsWith('/refund') && method === 'PUT') {
                        const id = orderId.replace('/refund', '');
                        return await handleAdminRefundOrder(env, id, body);
                    }
                    if (method === 'DELETE') {
                        return await handleAdminDeleteOrder(env, orderId);
                    }
                }
                if (path === '/api/admin/products' && method === 'GET') {
                    return await handleAdminGetProducts(env);
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
                    if (method === 'DELETE') {
                        return await handleAdminDeleteProduct(env, productId);
                    }
                }
            }
        }

        return errorResponse('接口不存在', 404);

    } catch (err) {
        console.error('Pages Functions 错误:', err);
        return errorResponse(err.message || '服务器内部错误', 500);
    }
}