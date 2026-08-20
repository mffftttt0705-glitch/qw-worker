// ============================================================
//  QW电竞 - 完整后端 API（Pages Functions 版本）
//  功能：店铺入驻 + 邀请码注册 + 店长系统 + 管理员封禁
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

function hasShopOwnerPermission(user) {
    return user.role === 'shop_owner' || user.is_admin === 1;
}

function hasAdminPermission(user) {
    return user.is_admin === 1;
}

async function getShopById(env, shopId) {
    const result = await queryDB(env, 'SELECT * FROM shops WHERE id = ?', [shopId]);
    return (result.results && result.results[0]) || null;
}

// ============================================================
//  1. 注册功能（邀请码决定店铺）
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

    // ===== 邀请码验证 =====
    if (!invite_code) {
        return errorResponse('请填写店铺邀请码');
    }

    const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ? AND status = "active"', [invite_code]);
    const shop = (shopResult.results && shopResult.results[0]) || null;
    if (!shop) {
        return errorResponse('邀请码无效或店铺已停用');
    }

    if (role === 'shop_owner') {
        if (!shop_name) return errorResponse('请填写俱乐部名称');
        const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ?', [shop_name]);
        if (nameCheck.results && nameCheck.results.length > 0) {
            return errorResponse('该俱乐部名称已被使用');
        }
    }

    const id = generateId();
    const userStatus = (role === 'handler' || role === 'shop_owner') ? 'pending' : (status || 'active');

    await runDB(env,
        `INSERT INTO users (id, username, password, role, diamond, balance, status, phone, register_ip, created_at, shop_id, shop_name, invite_code, is_admin) 
         VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, 0)`,
        [id, username, password, role || 'boss', userStatus, phone || '', clientIP, new Date().toISOString(), shop.id, shop_name || '', invite_code]
    );

    if (role === 'shop_owner' && shop_name) {
        const shopId = generateId();
        await runDB(env,
            `INSERT INTO shops (id, name, owner_id, invite_code, status, created_at, dispatch_to_all) 
             VALUES (?, ?, ?, ?, "pending", ?, 1)`,
            [shopId, shop_name, id, invite_code, new Date().toISOString()]
        );
        await runDB(env, 'UPDATE users SET shop_id = ? WHERE id = ?', [shopId, id]);
    }

    if (!registerCache[clientIP]) {
        registerCache[clientIP] = [];
    }
    registerCache[clientIP].push(Date.now());

    return jsonResponse({
        message: '注册成功',
        id,
        shop_id: shop.id,
        shop_name: shop.name,
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
            is_admin: user.is_admin || 0
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
//  3. 店铺入驻申请（无需登录）
// ============================================================

async function handleShopApply(env, body) {
    const { shop_name, username, password, invite_code } = body;
    if (!shop_name || !username || !password || !invite_code) {
        return errorResponse('请填写完整信息');
    }

    const existing = await queryDB(env, 'SELECT * FROM users WHERE username = ?', [username]);
    if (existing.results && existing.results.length > 0) {
        return errorResponse('用户名已存在');
    }

    const shopResult = await queryDB(env, 'SELECT * FROM shops WHERE invite_code = ? AND status = "active"', [invite_code]);
    const shop = (shopResult.results && shopResult.results[0]) || null;
    if (!shop) {
        return errorResponse('邀请码无效或店铺已停用');
    }

    const nameCheck = await queryDB(env, 'SELECT * FROM shops WHERE name = ?', [shop_name]);
    if (nameCheck.results && nameCheck.results.length > 0) {
        return errorResponse('该俱乐部名称已被使用');
    }

    const id = generateId();
    await runDB(env,
        `INSERT INTO shop_applications (id, shop_name, owner_username, owner_password, invite_code, status, created_at) 
         VALUES (?, ?, ?, ?, ?, "pending", ?)`,
        [id, shop_name, username, password, invite_code, new Date().toISOString()]
    );

    return jsonResponse({ success: true, message: '入驻申请已提交，请等待管理员审核' });
}
// ============================================================
//  4. 管理员 - 店铺申请管理
// ============================================================

async function handleAdminGetShopApplications(env) {
    const result = await queryDB(env, 'SELECT * FROM shop_applications ORDER BY created_at DESC');
    return jsonResponse(result.results || []);
}

async function handleAdminApproveShop(env, applicationId) {
    const appResult = await queryDB(env, 'SELECT * FROM shop_applications WHERE id = ?', [applicationId]);
    const app = (appResult.results && appResult.results[0]) || null;
    if (!app) return errorResponse('申请不存在', 404);
    if (app.status !== 'pending') return errorResponse('已处理');

    const userId = generateId();
    await runDB(env,
        `INSERT INTO users (id, username, password, role, diamond, balance, status, shop_name, invite_code, created_at, is_admin) 
         VALUES (?, ?, ?, "shop_owner", 0, 0, "active", ?, ?, ?, 0)`,
        [userId, app.owner_username, app.owner_password, app.shop_name, app.invite_code, new Date().toISOString()]
    );

    const shopId = generateId();
    await runDB(env,
        `INSERT INTO shops (id, name, owner_id, invite_code, status, created_at, dispatch_to_all) 
         VALUES (?, ?, ?, ?, "active", ?, 1)`,
        [shopId, app.shop_name, userId, app.invite_code, new Date().toISOString()]
    );

    await runDB(env, 'UPDATE users SET shop_id = ? WHERE id = ?', [shopId, userId]);
    await runDB(env, 'UPDATE shop_applications SET status = "approved", reviewed_at = ? WHERE id = ?',
        [new Date().toISOString(), applicationId]);

    return jsonResponse({ success: true, message: '入驻审核通过' });
}

async function handleAdminRejectShop(env, applicationId) {
    await runDB(env, 'UPDATE shop_applications SET status = "rejected", reviewed_at = ? WHERE id = ?',
        [new Date().toISOString(), applicationId]);
    return jsonResponse({ success: true, message: '已拒绝' });
}

// ============================================================
//  5. 管理员 - 店铺管理
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

async function handleAdminToggleShopOwner(env, userId) {
    const user = await getUserById(env, userId);
    if (!user) return errorResponse('用户不存在', 404);
    if (user.role !== 'shop_owner') return errorResponse('该用户不是店长');

    const newStatus = user.status === 'active' ? 'banned' : 'active';
    await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, userId]);

    if (user.shop_id) {
        const shopStatus = newStatus === 'active' ? 'active' : 'banned';
        await runDB(env, 'UPDATE shops SET status = ? WHERE id = ?', [shopStatus, user.shop_id]);

        if (newStatus === 'banned') {
            await runDB(env, 'UPDATE users SET status = "banned" WHERE shop_id = ? AND role != "shop_owner"', [user.shop_id]);
        } else {
            await runDB(env, 'UPDATE users SET status = "active" WHERE shop_id = ? AND role != "shop_owner" AND status != "banned"', [user.shop_id]);
        }
    }

    return jsonResponse({ success: true, message: `店长已${newStatus === 'active' ? '解封' : '封禁'}` });
}

// ============================================================
//  6. 店长接口
// ============================================================

async function handleShopOwnerGetShop(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);
    if (!user.shop_id) return errorResponse('未入驻店铺', 404);

    const shop = await getShopById(env, user.shop_id);
    if (!shop) return errorResponse('店铺不存在', 404);
    return jsonResponse(shop);
}

async function handleShopOwnerGetProducts(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);
    if (!user.shop_id) return jsonResponse([]);

    const result = await queryDB(env,
        'SELECT * FROM products WHERE shop_id = ? ORDER BY created_at DESC',
        [user.shop_id]
    );
    return jsonResponse(result.results || []);
}

async function handleShopOwnerCreateProduct(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);
    if (!user.shop_id) return errorResponse('未入驻店铺', 404);

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

async function handleShopOwnerUnshelf(env, authHeader, productId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const check = await queryDB(env, 'SELECT * FROM products WHERE id = ? AND shop_id = ?', [productId, user.shop_id]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('商品不存在或无权操作', 404);
    }
    await runDB(env, 'UPDATE products SET hidden = 1 WHERE id = ?', [productId]);
    return jsonResponse({ success: true, message: '已下架' });
}

async function handleShopOwnerReshelf(env, authHeader, productId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const check = await queryDB(env, 'SELECT * FROM products WHERE id = ? AND shop_id = ?', [productId, user.shop_id]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('商品不存在或无权操作', 404);
    }
    await runDB(env, 'UPDATE products SET hidden = 0 WHERE id = ?', [productId]);
    return jsonResponse({ success: true, message: '已重新上架' });
}

async function handleShopOwnerDeleteProduct(env, authHeader, productId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const check = await queryDB(env, 'SELECT * FROM products WHERE id = ? AND shop_id = ?', [productId, user.shop_id]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('商品不存在或无权操作', 404);
    }
    await runDB(env, 'DELETE FROM products WHERE id = ?', [productId]);
    return jsonResponse({ success: true, message: '已删除' });
}

async function handleShopOwnerGetOrders(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const result = await queryDB(env,
        'SELECT * FROM orders WHERE shop_id = ? ORDER BY created_at DESC',
        [user.shop_id]
    );
    return jsonResponse(result.results || []);
}

async function handleShopOwnerGetAnnounce(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const result = await queryDB(env,
        'SELECT * FROM announces WHERE shop_id = ? ORDER BY updated_at DESC LIMIT 1',
        [user.shop_id]
    );
    const data = (result.results && result.results[0]) || { content: '欢迎来到我们的俱乐部！', images: '[]' };
    if (typeof data.images === 'string') {
        try { data.images = JSON.parse(data.images); } catch (e) { data.images = []; }
    }
    return jsonResponse(data);
}

async function handleShopOwnerUpdateAnnounce(env, authHeader, body) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const { content, images } = body;
    await runDB(env, 'DELETE FROM announces WHERE shop_id = ?', [user.shop_id]);
    const imagesJson = Array.isArray(images) ? JSON.stringify(images) : '[]';
    await runDB(env,
        'INSERT INTO announces (id, content, images, updated_at, shop_id) VALUES (?, ?, ?, ?, ?)',
        [generateId(), content || '欢迎来到我们的俱乐部！', imagesJson, new Date().toISOString(), user.shop_id]
    );
    return jsonResponse({ success: true, message: '公告已更新' });
}

async function handleShopOwnerGetUsers(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const result = await queryDB(env,
        'SELECT id, username, role, diamond, balance, status FROM users WHERE shop_id = ? AND id != ?',
        [user.shop_id, userId]
    );
    return jsonResponse(result.results || []);
}

async function handleShopOwnerToggleBan(env, authHeader, targetUserId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const target = await getUserById(env, targetUserId);
    if (!target) return errorResponse('用户不存在', 404);
    if (target.shop_id !== user.shop_id) return errorResponse('无权操作', 403);
    if (target.role === 'shop_owner') return errorResponse('不能操作店长', 403);

    const newStatus = target.status === 'active' ? 'banned' : 'active';
    await runDB(env, 'UPDATE users SET status = ? WHERE id = ?', [newStatus, targetUserId]);
    return jsonResponse({ success: true, message: '用户状态已更新' });
}

async function handleShopOwnerResetPassword(env, authHeader, targetUserId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const target = await getUserById(env, targetUserId);
    if (!target) return errorResponse('用户不存在', 404);
    if (target.shop_id !== user.shop_id) return errorResponse('无权操作', 403);
    if (target.role === 'shop_owner') return errorResponse('不能操作店长', 403);

    await runDB(env, 'UPDATE users SET password = "123456" WHERE id = ?', [targetUserId]);
    return jsonResponse({ success: true, message: '密码已重置为 123456' });
}

async function handleShopOwnerGetRecharges(env, authHeader) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const result = await queryDB(env,
        'SELECT * FROM recharges WHERE shop_id = ? ORDER BY created_at DESC',
        [user.shop_id]
    );
    return jsonResponse(result.results || []);
}

async function handleShopOwnerApproveRecharge(env, authHeader, rechargeId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const shop = await getShopById(env, user.shop_id);
    if (!shop) return errorResponse('店铺不存在', 404);

    const rechargeResult = await queryDB(env, 'SELECT * FROM recharges WHERE id = ? AND shop_id = ?', [rechargeId, user.shop_id]);
    const recharge = (rechargeResult.results && rechargeResult.results[0]) || null;
    if (!recharge || recharge.status !== 'pending') return errorResponse('记录不存在或已处理');

    if (shop.diamond < recharge.diamond) {
        return errorResponse('店铺红钻不足，请先充值', 400);
    }

    await runDB(env, 'UPDATE shops SET diamond = diamond - ? WHERE id = ?', [recharge.diamond, shop.id]);
    await runDB(env, 'UPDATE users SET diamond = diamond + ? WHERE id = ?', [recharge.diamond, recharge.user_id]);
    await runDB(env, 'UPDATE recharges SET status = "approved", approve_time = ? WHERE id = ?',
        [new Date().toISOString(), rechargeId]);

    return jsonResponse({ success: true, message: '充值通过，红钻已到账' });
}

async function handleShopOwnerRejectRecharge(env, authHeader, rechargeId) {
    const userId = verifyAndGetUserId(authHeader);
    if (!userId) return errorResponse('请先登录', 401);
    const user = await getUserById(env, userId);
    if (!user || !hasShopOwnerPermission(user)) return errorResponse('无权限', 403);

    const check = await queryDB(env, 'SELECT * FROM recharges WHERE id = ? AND shop_id = ?', [rechargeId, user.shop_id]);
    if (!check.results || check.results.length === 0) {
        return errorResponse('记录不存在', 404);
    }
    await runDB(env, 'UPDATE recharges SET status = "rejected", approve_time = ? WHERE id = ?',
        [new Date().toISOString(), rechargeId]);
    return jsonResponse({ success: true, message: '已拒绝' });
}

// ============================================================
//  7. 商品获取（老板看到自己店铺的商品）
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
//  8. 打手获取待接单列表（支持过滤）
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
//  9. 购买商品
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
//  10. 我的订单
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
//  11. Pages Functions 入口
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
        if (path === '/api/shop/apply' && method === 'POST') {
            return await handleShopApply(env, body);
        }

        // ===== 需要登录的接口 =====
        if (path === '/api/me' && method === 'GET') {
            return await handleGetMe(env, authHeader);
        }
        if (path === '/api/products' && method === 'GET') {
            return await handleGetProducts(env, authHeader);
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

        // ===== 店长/管理员店铺接口 =====
        if (userId) {
            const user = await getUserById(env, userId);
            if (user && hasShopOwnerPermission(user)) {
                if (path === '/api/shop/owner/info' && method === 'GET') {
                    return await handleShopOwnerGetShop(env, authHeader);
                }
                if (path === '/api/shop/owner/products' && method === 'GET') {
                    return await handleShopOwnerGetProducts(env, authHeader);
                }
                if (path === '/api/shop/owner/products' && method === 'POST') {
                    return await handleShopOwnerCreateProduct(env, authHeader, body);
                }
                if (path.startsWith('/api/shop/owner/products/')) {
                    const productId = path.replace('/api/shop/owner/products/', '');
                    if (productId.endsWith('/unshelf') && method === 'PUT') {
                        const id = productId.replace('/unshelf', '');
                        return await handleShopOwnerUnshelf(env, authHeader, id);
                    }
                    if (productId.endsWith('/reshelf') && method === 'PUT') {
                        const id = productId.replace('/reshelf', '');
                        return await handleShopOwnerReshelf(env, authHeader, id);
                    }
                    if (method === 'DELETE') {
                        return await handleShopOwnerDeleteProduct(env, authHeader, productId);
                    }
                }
                if (path === '/api/shop/owner/orders' && method === 'GET') {
                    return await handleShopOwnerGetOrders(env, authHeader);
                }
                if (path === '/api/shop/owner/announce' && method === 'GET') {
                    return await handleShopOwnerGetAnnounce(env, authHeader);
                }
                if (path === '/api/shop/owner/announce' && method === 'PUT') {
                    return await handleShopOwnerUpdateAnnounce(env, authHeader, body);
                }
                if (path === '/api/shop/owner/users' && method === 'GET') {
                    return await handleShopOwnerGetUsers(env, authHeader);
                }
                if (path.startsWith('/api/shop/owner/users/')) {
                    const targetUserId = path.replace('/api/shop/owner/users/', '');
                    if (targetUserId.endsWith('/ban') && method === 'PUT') {
                        const id = targetUserId.replace('/ban', '');
                        return await handleShopOwnerToggleBan(env, authHeader, id);
                    }
                    if (targetUserId.endsWith('/reset-password') && method === 'PUT') {
                        const id = targetUserId.replace('/reset-password', '');
                        return await handleShopOwnerResetPassword(env, authHeader, id);
                    }
                }
                if (path === '/api/shop/owner/recharges' && method === 'GET') {
                    return await handleShopOwnerGetRecharges(env, authHeader);
                }
                if (path.startsWith('/api/shop/owner/recharges/')) {
                    const rechargeId = path.replace('/api/shop/owner/recharges/', '');
                    if (rechargeId.endsWith('/approve') && method === 'PUT') {
                        const id = rechargeId.replace('/approve', '');
                        return await handleShopOwnerApproveRecharge(env, authHeader, id);
                    }
                    if (rechargeId.endsWith('/reject') && method === 'PUT') {
                        const id = rechargeId.replace('/reject', '');
                        return await handleShopOwnerRejectRecharge(env, authHeader, id);
                    }
                }
            }

            // ===== 管理员接口 =====
            if (user && hasAdminPermission(user)) {
                if (path === '/api/admin/shop-applications' && method === 'GET') {
                    return await handleAdminGetShopApplications(env);
                }
                if (path.startsWith('/api/admin/shop-applications/')) {
                    const appId = path.replace('/api/admin/shop-applications/', '');
                    if (appId.endsWith('/approve') && method === 'PUT') {
                        const id = appId.replace('/approve', '');
                        return await handleAdminApproveShop(env, id);
                    }
                    if (appId.endsWith('/reject') && method === 'PUT') {
                        const id = appId.replace('/reject', '');
                        return await handleAdminRejectShop(env, id);
                    }
                }
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
                }
                if (path.startsWith('/api/admin/shop-owner/')) {
                    const targetUserId = path.replace('/api/admin/shop-owner/', '');
                    if (targetUserId.endsWith('/toggle') && method === 'PUT') {
                        const id = targetUserId.replace('/toggle', '');
                        return await handleAdminToggleShopOwner(env, id);
                    }
                }
            }
        }

        // ===== 原有接口（聊天、接单等）- 保留 =====
        // 由于这些接口在您的原有代码中已有，这里不再重复
        // 请确保您的原有接口仍然可用

        return errorResponse('接口不存在', 404);

    } catch (err) {
        console.error('Pages Functions 错误:', err);
        return errorResponse(err.message || '服务器内部错误', 500);
    }
}