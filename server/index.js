const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const { initDb } = require('./database');
const { BUILDING_DATA, KNIGHT_COST } = require('./gameLogic');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../client')));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

const SECRET = 'city-knight-secret-123';
let db;
let lastDayStart = Date.now();

async function emitUserState(userId) {
    const user = await db.get('SELECT * FROM users WHERE id = ?', [userId]);
    const buildings = await db.all('SELECT * FROM buildings WHERE user_id = ?', [userId]);
    const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [userId]);
    const dayTimeLeft = Math.max(0, 300 - (Date.now() - (lastDayStart || Date.now())) / 1000);
    io.to(`user_${userId}`).emit('game_init', { user, buildings, knights, dayTimeLeft });
}

async function startServer() {
    db = await initDb();

    // REST API for Auth
    app.post('/api/register', async (req, res) => {
        const { username, password } = req.body;
        if (!username || !password) return res.status(400).json({ error: 'Missing fields' });

        try {
            const hashedPassword = await bcrypt.hash(password, 10);
            const startX = Math.random() * 2000;
            const startY = Math.random() * 2000;
            const result = await db.run(
                'INSERT INTO users (username, password, gold, food, water, people_count, x, y, is_placed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
                [username, hashedPassword, 1000, 500, 500, 5, startX, startY, 0]
            );
            const userId = result.lastID;

            const token = jwt.sign({ id: userId, username }, SECRET);
            res.json({ token, user: { id: userId, username, gold: 1000, food: 500, water: 500, is_placed: 0 } });
        } catch (err) {
            res.status(400).json({ error: 'Username already exists' });
        }
    });

    app.post('/api/login', async (req, res) => {
        const { username, password } = req.body;
        const user = await db.get('SELECT * FROM users WHERE username = ?', [username]);
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [user.id]);
        const token = jwt.sign({ id: user.id, username }, SECRET);
        res.json({ token, user: { ...user, password: '', knights } });
    });

    app.post('/api/sell-food', async (req, res) => {
        const { token, amount } = req.body;
        try {
            const decoded = jwt.verify(token, SECRET);
            const user = await db.get('SELECT gold, food FROM users WHERE id = ?', [decoded.id]);
            if (user.food < amount) return res.status(400).json({ error: 'Not enough food' });

            const goldGain = Math.floor(amount / 2);
            await db.run('UPDATE users SET food = food - ?, gold = gold + ? WHERE id = ?', [amount, goldGain, decoded.id]);
            res.json({ success: true, gold: user.gold + goldGain, food: user.food - amount });
        } catch (err) {
            res.status(401).json({ error: 'Unauthorized' });
        }
    });

    app.post('/api/sell-water', async (req, res) => {
        const { token, amount } = req.body;
        try {
            const decoded = jwt.verify(token, SECRET);
            const user = await db.get('SELECT gold, water FROM users WHERE id = ?', [decoded.id]);
            if (user.water < amount) return res.status(400).json({ error: 'Not enough water' });

            const goldGain = Math.floor(amount / 3);
            await db.run('UPDATE users SET water = water - ?, gold = gold + ? WHERE id = ?', [amount, goldGain, decoded.id]);
            res.json({ success: true, gold: user.gold + goldGain, water: user.water - amount });
        } catch (err) {
            res.status(401).json({ error: 'Unauthorized' });
        }
    });

    // Socket.io for Real-time Game State
    io.on('connection', (socket) => {
        console.log('User connected:', socket.id);

        socket.on('join_game', async (token) => {
            try {
                const decoded = jwt.verify(token, SECRET);
                socket.userId = decoded.id;
                socket.join(`user_${decoded.id}`);

                // Send initial state
                const user = await db.get('SELECT * FROM users WHERE id = ?', [decoded.id]);
                if (!user) {
                    socket.emit('error', 'Session expired. Please log in again.');
                    return;
                }
                const buildings = await db.all('SELECT * FROM buildings WHERE user_id = ?', [decoded.id]);
                const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [decoded.id]);

                // Send all world buildings for exploration
                const worldBuildings = await db.all('SELECT b.*, u.username as owner FROM buildings b JOIN users u ON b.user_id = u.id');

                socket.emit('game_init', {
                    user,
                    buildings,
                    knights,
                    worldBuildings, // Send all buildings
                    dayTimeLeft: Math.max(0, 300 - (Date.now() - (lastDayStart || Date.now())) / 1000)
                });
            } catch (err) {
                socket.emit('error', 'Invalid token');
            }
        });

        socket.on('move', async ({ x, y }) => {
            if (!socket.userId) return;
            await db.run('UPDATE users SET x = ?, y = ? WHERE id = ?', [x, y, socket.userId]);
            const user = await db.get('SELECT * FROM users WHERE id = ?', [socket.userId]);

            // Broadcast movement to everyone (simple world map)
            socket.broadcast.emit('player_moved', { id: socket.userId, username: user.username, x, y });
        });

        socket.on('place_city', async () => {
            if (!socket.userId) return;
            const user = await db.get('SELECT * FROM users WHERE id = ?', [socket.userId]);
            if (user.is_placed) return socket.emit('error', 'City already placed!');

            const cityX = user.x;
            const cityY = user.y;

            await db.run('UPDATE users SET city_x = ?, city_y = ?, is_placed = 1 WHERE id = ?', [cityX, cityY, socket.userId]);

            const mainHouseData = BUILDING_DATA.main_house;
            const result = await db.run(
                'INSERT INTO buildings (user_id, type, x, y, world_x, world_y, health, max_health) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                [socket.userId, 'main_house', 10, 10, cityX, cityY, mainHouseData.health, mainHouseData.health]
            );

            const newCity = { id: result.lastID, user_id: socket.userId, type: 'main_house', x: 10, y: 10, world_x: cityX, world_y: cityY, health: mainHouseData.health, max_health: mainHouseData.health, owner: user.username };
            io.emit('new_building', newCity);

            await emitUserState(socket.userId);
            socket.emit('error', 'Kingdom established! You are now vulnerable to attacks.');
        });

        socket.on('attack_building', async ({ buildingId, knightIds }) => {
            if (!socket.userId || !knightIds || knightIds.length === 0) return;

            const building = await db.get('SELECT * FROM buildings WHERE id = ?', [buildingId]);
            if (!building || building.user_id === socket.userId) return;

            const attacker = await db.get('SELECT * FROM users WHERE id = ?', [socket.userId]);
            const defender = await db.get('SELECT * FROM users WHERE id = ?', [building.user_id]);

            if (!defender || !defender.is_placed || !attacker.is_placed) {
                return socket.emit('error', 'Cannot attack players who haven\'t placed their city!');
            }

            // Simple damage: each knight does 10 damage
            const damage = knightIds.length * 10;
            const newHealth = Math.max(0, building.health - damage);

            if (newHealth <= 0) {
                await db.run('DELETE FROM buildings WHERE id = ?', [buildingId]);
                // Check if main house was destroyed - maybe game over logic?
                if (building.type === 'main_house') {
                    io.emit('error', `Kingdom of ${defender.username} has fallen!`);
                    await db.run('UPDATE users SET is_placed = 0 WHERE id = ?', [building.user_id]);
                    await db.run('DELETE FROM buildings WHERE user_id = ?', [building.user_id]);
                    // Also maybe kill all knights?
                    // await db.run('DELETE FROM knights WHERE user_id = ?', [building.user_id]);
                }
                socket.emit('error', `Destroyed enemy ${building.type}!`);
            } else {
                await db.run('UPDATE buildings SET health = ? WHERE id = ?', [newHealth, buildingId]);
            }

            // Notify owner
            io.to(`user_${building.user_id}`).emit('error', `Your ${building.type} is being attacked!`);
            await emitUserState(building.user_id);
            // We need a way to update the attacker's view too
            io.emit('world_building_update', { buildingId: building.id, health: newHealth });
        });

        socket.on('steal_loot', async ({ targetUserId }) => {
            if (!socket.userId) return;
            const attacker = await db.get('SELECT * FROM users WHERE id = ?', [socket.userId]);
            const defender = await db.get('SELECT * FROM users WHERE id = ?', [targetUserId]);

            if (!defender || !defender.is_placed || !attacker.is_placed) {
                return socket.emit('error', 'Cannot loot players who haven\'t placed their city!');
            }

            const attackerKnights = await db.all('SELECT * FROM knights WHERE user_id = ?', [socket.userId]);

            if (!defender) return;

            // Check distance (if attacker is at defender's city center)
            const dist = Math.hypot(attacker.x - defender.city_x, attacker.y - defender.city_y);

            if (dist > 150) {
                return socket.emit('error', 'Too far to steal loot! Get closer to the city center.');
            }

            if (attackerKnights.length > 0) {
                const lootGold = Math.floor(defender.gold * 0.2);
                const lootFood = Math.floor(defender.food * 0.2);

                await db.run('UPDATE users SET gold = gold + ?, food = food + ? WHERE id = ?', [lootGold, lootFood, socket.userId]);
                await db.run('UPDATE users SET gold = gold - ?, food = food - ? WHERE id = ?', [lootGold, lootFood, targetUserId]);

                await emitUserState(socket.userId);
                await emitUserState(targetUserId);
                socket.emit('error', `LOOTED ${defender.username}! Stole ${lootGold}g and ${lootFood}f!`);
                io.to(`user_${targetUserId}`).emit('error', `You have been looted by ${attacker.username}!`);
            } else {
                socket.emit('error', 'You need knights to carry the loot!');
            }
        });

        socket.on('build', async ({ type, x, y }) => {
            if (!socket.userId) return;
            const data = BUILDING_DATA[type];
            if (!data) return;

            const user = await db.get('SELECT gold, food, water FROM users WHERE id = ?', [socket.userId]);
            if (!user) return;

            const buildings = await db.all('SELECT * FROM buildings WHERE user_id = ?', [socket.userId]);
            const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [socket.userId]);

            const houseCount = buildings.filter(b => b.type === 'house').length;
            const maxPop = houseCount * 5;

            const farms = buildings.filter(b => b.type === 'farm');
            const wells = buildings.filter(b => b.type === 'well');
            const currentWorkers = (farms.length * 5) + (wells.length * 1);
            const currentTotalPop = currentWorkers + knights.length;

            const addedWorkers = data.workersNeeded || 0;
            if (type !== 'house' && currentTotalPop + addedWorkers > maxPop) {
                return socket.emit('error', 'Not enough houses! You need more beds for workers.');
            }

            if (user.gold >= data.costGold && (user.food || 0) >= (data.costFood || 0)) {
                // Calculate world position based on city anchor
                const worldX = user.city_x + (x - 10) * 50;
                const worldY = user.city_y + (y - 10) * 50;

                await db.run('UPDATE users SET gold = gold - ?, food = food - ? WHERE id = ?', [data.costGold, data.costFood || 0, socket.userId]);
                const result = await db.run('INSERT INTO buildings (user_id, type, x, y, world_x, world_y, health, max_health) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    [socket.userId, type, x, y, worldX, worldY, data.health, data.health]);

                const newBuilding = { id: result.lastID, user_id: socket.userId, type, x, y, world_x: worldX, world_y: worldY, health: data.health, max_health: data.health, owner: user.username };
                io.emit('new_building', newBuilding);

                await emitUserState(socket.userId);
            } else {
                socket.emit('error', `Need ${data.costGold}g and ${data.costFood || 0}f`);
            }
        });

        socket.on('destroy_building', async ({ buildingId }) => {
            if (!socket.userId) return;
            const building = await db.get('SELECT * FROM buildings WHERE id = ? AND user_id = ?', [buildingId, socket.userId]);
            if (!building) return;

            const data = BUILDING_DATA[building.type];
            const refund = Math.floor((data.costGold || 0) * 0.8);

            await db.run('DELETE FROM buildings WHERE id = ?', [buildingId]);
            await db.run('UPDATE users SET gold = gold + ? WHERE id = ?', [refund, socket.userId]);

            io.emit('building_destroyed', buildingId);
            await emitUserState(socket.userId);
            socket.emit('error', `Destroyed ${building.type}. Refunded ${refund} gold.`);
        });

        socket.on('toggle_door', async ({ buildingId }) => {
            if (!socket.userId) return;
            const building = await db.get('SELECT * FROM buildings WHERE id = ? AND user_id = ? AND type = "door"', [buildingId, socket.userId]);
            if (!building) return;

            const newState = building.state === 'open' ? 'closed' : 'open';
            await db.run('UPDATE buildings SET state = ? WHERE id = ?', [newState, buildingId]);
            await emitUserState(socket.userId);
        });

        socket.on('train_knight', async ({ name }) => {
            if (!socket.userId) return;
            const user = await db.get('SELECT * FROM users WHERE id = ?', [socket.userId]);
            const buildings = await db.all('SELECT * FROM buildings WHERE user_id = ?', [socket.userId]);
            const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [socket.userId]);

            const barracks = buildings.filter(b => b.type === 'barracks');
            if (barracks.length === 0) return socket.emit('error', 'Need barracks to train knights');
            if (knights.length >= barracks.length * 3) return socket.emit('error', 'All barracks are full! (3 per barrack)');

            // Housing check
            const houseCount = buildings.filter(b => b.type === 'house').length;
            const maxPop = houseCount * 5;
            const currentWorkers = (buildings.filter(b => b.type === 'farm').length * 5) + (buildings.filter(b => b.type === 'well').length * 1);
            if (currentWorkers + knights.length + 1 > maxPop) {
                return socket.emit('error', 'Not enough houses! You need more beds for your army.');
            }

            const cost = KNIGHT_COST;
            if (user.gold >= cost.gold && user.food >= cost.food) {
                await db.run('UPDATE users SET gold = gold - ?, food = food - ? WHERE id = ?', [cost.gold, cost.food, socket.userId]);
                await db.run('INSERT INTO knights (user_id, name, health, max_health) VALUES (?, ?, ?, ?)', [socket.userId, name || `Knight ${knights.length + 1}`, 100, 100]);
                await emitUserState(socket.userId);
            } else {
                socket.emit('error', `Need ${cost.gold}g and ${cost.food}f`);
            }
        });

        socket.on('retrain_knight', async ({ knightId }) => {
            if (!socket.userId) return;
            const knight = await db.get('SELECT * FROM knights WHERE id = ? AND user_id = ?', [knightId, socket.userId]);
            if (!knight) return;

            const cost = 100 * knight.level; // Gets more expensive
            const user = await db.get('SELECT gold FROM users WHERE id = ?', [socket.userId]);

            if (user.gold >= cost) {
                await db.run('UPDATE users SET gold = gold - ? WHERE id = ?', [cost, socket.userId]);
                await db.run('UPDATE knights SET level = level + 1 WHERE id = ?', [knightId]);
                await emitUserState(socket.userId);
                socket.emit('error', `Knight ${knight.name} leveled up to ${knight.level + 1}!`);
            } else {
                socket.emit('error', `Need ${cost} gold to retrain`);
            }
        });




        socket.on('disconnect', () => {
            console.log('User disconnected:', socket.id);
            if (socket.userId) {
                socket.broadcast.emit('player_disconnected', socket.userId);
            }
        });
    });

    const PORT = process.env.PORT || 3000;
    server.listen(PORT, () => {
        console.log(`Server running on port ${PORT}`);
    });

    // Combat Loop: Every 2 seconds
    setInterval(async () => {
        // 1. Cannons attack nearby enemy knights/players
        const cannons = await db.all('SELECT b.*, u.username FROM buildings b JOIN users u ON b.user_id = u.id WHERE b.type = "cannon"');
        const users = await db.all('SELECT * FROM users WHERE is_placed = 1');

        for (const cannon of cannons) {
            // Find closest enemy player (not the owner)
            for (const targetUser of users) {
                if (targetUser.id === cannon.user_id) continue;

                const dist = Math.hypot(cannon.world_x - targetUser.x, cannon.world_y - targetUser.y);
                if (dist < 300) {
                    // Attack player's knights!
                    const knight = await db.get('SELECT * FROM knights WHERE user_id = ? ORDER BY RANDOM() LIMIT 1', [targetUser.id]);
                    if (knight) {
                        const damage = 20;
                        await db.run('UPDATE knights SET health = health - ? WHERE id = ?', [damage, knight.id]);
                        io.emit('unit_attacked', { type: 'knight', id: knight.id, damage, x: targetUser.x, y: targetUser.y });

                        // Check if killed
                        if (knight.health - damage <= 0) {
                            await db.run('DELETE FROM knights WHERE id = ?', [knight.id]);
                            io.emit('unit_killed', { type: 'knight', id: knight.id });
                        }
                        break; // Attack one target per tick
                    }
                }
            }
        }

        // 2. Knights attack nearby enemies
        const allKnights = await db.all('SELECT k.*, u.username, u.x, u.y FROM knights k JOIN users u ON k.user_id = u.id');
        for (const k of allKnights) {
            // Check for nearby enemy users/knights
            for (const other of users) {
                if (other.id === k.user_id) continue;
                const dist = Math.hypot(k.x - other.x, k.y - other.y);
                if (dist < 100) {
                    // Damage enemy knights
                    const enemyKnight = await db.get('SELECT * FROM knights WHERE user_id = ? ORDER BY RANDOM() LIMIT 1', [other.id]);
                    if (enemyKnight) {
                        const damage = 10;
                        await db.run('UPDATE knights SET health = health - ? WHERE id = ?', [damage, enemyKnight.id]);
                        io.emit('unit_attacked', { type: 'knight', id: enemyKnight.id, damage, x: other.x, y: other.y });
                        if (enemyKnight.health - damage <= 0) {
                            await db.run('DELETE FROM knights WHERE id = ?', [enemyKnight.id]);
                            io.emit('unit_killed', { type: 'knight', id: enemyKnight.id });
                        }
                    }
                }
            }
        }
    }, 2000);

    // Resource Tick: Every 1 second for production (Real-time update)
    setInterval(async () => {
        const users = await db.all('SELECT id FROM users');
        for (const user of users) {
            // 1. Water Production (from Wells): ~1.6 water per 1s (prev 16 per 10s)
            const wells = await db.get('SELECT COUNT(*) as count FROM buildings WHERE user_id = ? AND type = "well"', [user.id]);
            const waterGain = wells.count * 1.6;

            // 2. Food Production (from Farms): 1 food per 1s (prev 10 per 10s)
            const farms = await db.get('SELECT COUNT(*) as count FROM buildings WHERE user_id = ? AND type = "farm"', [user.id]);
            const foodGain = farms.count * 1;

            if (waterGain > 0 || foodGain > 0) {
                await db.run('UPDATE users SET water = water + ?, food = food + ? WHERE id = ?', [waterGain, foodGain, user.id]);
                await emitUserState(user.id);
            }
        }
    }, 1000);

    // Day Cycle: Every 5 minutes (300 seconds) for consumption
    setInterval(async () => {
        lastDayStart = Date.now();
        const users = await db.all('SELECT * FROM users');
        for (const user of users) {
            const knights = await db.all('SELECT * FROM knights WHERE user_id = ?', [user.id]);
            const farms = await db.all('SELECT * FROM buildings WHERE user_id = ? AND type = "farm"', [user.id]);
            const wells = await db.all('SELECT * FROM buildings WHERE user_id = ? AND type = "well"', [user.id]);

            // Consumption Calc
            let totalFoodNeeded = 0;
            let totalWaterNeeded = 0;

            // Knights: 10f, 20w
            totalFoodNeeded += knights.length * 10;
            totalWaterNeeded += knights.length * 20;

            // Well People: 1 per well, needs 5f, 10w
            totalFoodNeeded += wells.length * 5;
            totalWaterNeeded += wells.length * 10;

            // Farm People: 5 per farm, each needs 5f, 5w
            totalFoodNeeded += farms.length * 5 * 5;
            totalWaterNeeded += farms.length * 5 * 5;

            if (user.food < totalFoodNeeded || user.water < totalWaterNeeded) {
                // Not enough! Remove something.
                io.to(`user_${user.id}`).emit('error', 'WARNING: Not enough resources to sustain kingdom! A knight has left...');
                if (knights.length > 0) {
                    await db.run('DELETE FROM knights WHERE id = (SELECT id FROM knights WHERE user_id = ? LIMIT 1)', [user.id]);
                } else if (farms.length > 0) {
                    await db.run('DELETE FROM buildings WHERE id = (SELECT id FROM buildings WHERE user_id = ? AND type = "farm" LIMIT 1)', [user.id]);
                }
            } else {
                await db.run('UPDATE users SET food = food - ?, water = water - ? WHERE id = ?', [totalFoodNeeded, totalWaterNeeded, user.id]);
                io.to(`user_${user.id}`).emit('error', `A new day has passed. Consumed ${totalFoodNeeded} food and ${totalWaterNeeded} water.`);
            }
            await emitUserState(user.id);
        }
    }, 300000);

    // Cannon Tick: Every 2 seconds
    setInterval(async () => {
        const cannons = await db.all('SELECT * FROM buildings WHERE type = "cannon"');
        for (const cannon of cannons) {
            const data = BUILDING_DATA.cannon;
            // Find nearby enemies (other players)
            const nearbyEnemies = await db.all(`
                SELECT id, username, x, y FROM users WHERE id != ?
            `, [cannon.user_id]);

            for (const enemy of nearbyEnemies) {
                const dist = Math.hypot(enemy.x - cannon.x * 50, enemy.y - cannon.y * 50);
                if (dist < data.range) {
                    // Fire! Damage a knight
                    const enemyKnight = await db.get('SELECT id FROM knights WHERE user_id = ? LIMIT 1', [enemy.id]);
                    if (enemyKnight) {
                        await db.run('DELETE FROM knights WHERE id = ?', [enemyKnight.id]);
                        io.to(`user_${enemy.id}`).emit('error', `A cannon ball hit your army! You lost a knight.`);
                        await emitUserState(enemy.id);
                    }
                }
            }
        }
    }, 2000);
}

startServer();
