import { io } from "https://cdn.socket.io/4.7.2/socket.io.esm.min.js";

const app = {
    socket: null,
    token: localStorage.getItem('token'),
    user: null,
    buildings: [],
    knights: [],
    selectedKnights: new Set(),
    isDeconstructMode: false,
    stance: 'Aggressive',
    others: {},
    worldBuildings: [],
    currentAction: null,
    canvas: document.getElementById('game-canvas'),
    ctx: null,
    keys: {},
    lastMoveUpdate: 0,
    dayTimeLeft: 300,
    camera: { x: 0, y: 0 },

    init() {
        this.ctx = this.canvas.getContext('2d');
        this.resize();
        window.addEventListener('resize', () => this.resize());

        this.setupAuth();
        this.setupGameUI();
        this.setupControls();

        if (this.token) {
            this.connect();
        }

        this.animate();
    },

    resize() {
        this.canvas.width = window.innerWidth;
        this.canvas.height = window.innerHeight;
    },

    setupAuth() {
        const loginBtn = document.getElementById('tab-login');
        const regBtn = document.getElementById('tab-register');
        const authSubmit = document.getElementById('auth-submit');
        let mode = 'login';

        loginBtn.onclick = () => {
            mode = 'login';
            loginBtn.classList.add('active');
            regBtn.classList.remove('active');
            authSubmit.textContent = 'Enter Kingdom';
        };

        regBtn.onclick = () => {
            mode = 'register';
            regBtn.classList.add('active');
            loginBtn.classList.remove('active');
            authSubmit.textContent = 'Found Kingdom';
        };

        authSubmit.onclick = async () => {
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            const errorEl = document.getElementById('auth-error');

            try {
                const res = await fetch(`http://localhost:3000/api/${mode}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ username, password })
                });
                const data = await res.json();

                if (data.error) {
                    errorEl.textContent = data.error;
                } else {
                    this.token = data.token;
                    localStorage.setItem('token', this.token);
                    this.user = data.user;
                    this.connect();
                }
            } catch (err) {
                errorEl.textContent = 'Connection failed';
            }
        };

        document.getElementById('logout-btn').onclick = () => {
            localStorage.removeItem('token');
            location.reload();
        };
    },

    connect() {
        this.socket = io(); // Connects to the host that served the page (supports LAN)
        this.setupSocketEvents();

        this.socket.on('connect', () => {
            this.socket.emit('join_game', this.token);
        });

        this.socket.on('game_init', ({ user, buildings, knights, worldBuildings, dayTimeLeft }) => {
            this.user = user;
            this.buildings = buildings;
            this.knights = knights || [];
            if (worldBuildings) this.worldBuildings = worldBuildings;
            this.dayTimeLeft = dayTimeLeft;

            // Initialize knight positions if not set
            if (!this.knightPositions) this.knightPositions = {};
            this.knights.forEach(k => {
                if (!this.knightPositions[k.id]) {
                    this.knightPositions[k.id] = { x: user.x, y: user.y };
                }
            });

            this.updateStats();

            // Only hide auth when we have valid data
            document.getElementById('auth-screen').classList.add('hidden');
            document.getElementById('game-screen').classList.remove('hidden');
        });

        this.socket.on('new_building', (building) => {
            if (!this.worldBuildings) this.worldBuildings = [];
            this.worldBuildings.push(building);
            if (building.user_id === this.user.id) {
                // It's mine too, handled by emitUserState usually, but double check
            }
        });

        this.socket.on('building_destroyed', (id) => {
            if (this.worldBuildings) {
                this.worldBuildings = this.worldBuildings.filter(b => b.id !== id);
            }
        });

        this.socket.on('world_building_update', ({ buildingId, health }) => {
            if (this.worldBuildings) {
                const b = this.worldBuildings.find(b => b.id === buildingId);
                if (b) b.health = health;
            }
            const myB = this.buildings.find(b => b.id === buildingId);
            if (myB) myB.health = health;
        });
    },

    setupGameUI() {
        const placeBtn = document.getElementById('place-city-btn');
        placeBtn.onclick = () => {
            this.socket.emit('place_city');
        };

        const buildBtns = document.querySelectorAll('.build-btn');
        buildBtns.forEach(btn => {
            btn.onclick = () => {
                this.currentAction = { type: 'build', buildingType: btn.dataset.type };
                btn.style.borderColor = '#d4af37';
            };
        });

        document.getElementById('train-knight-btn').onclick = () => {
            const name = document.getElementById('knight-name').value;
            this.socket.emit('train_knight', { name });
            document.getElementById('knight-name').value = '';
        };

        document.getElementById('deconstruct-mode-btn').onclick = (e) => {
            this.isDeconstructMode = !this.isDeconstructMode;
            e.target.classList.toggle('active', this.isDeconstructMode);
            this.currentAction = this.isDeconstructMode ? { type: 'deconstruct' } : null;
        };

        document.getElementById('stance-toggle-btn').onclick = (e) => {
            this.stance = this.stance === 'Aggressive' ? 'Defensive' : 'Aggressive';
            e.target.textContent = `🛡️ Stance: ${this.stance}`;
        };

        document.getElementById('select-all-knights-btn').onclick = () => {
            if (this.selectedKnights.size === this.knights.length) {
                this.selectedKnights.clear();
            } else {
                this.knights.forEach(k => this.selectedKnights.add(k.id));
            }
            this.updateStats();
        };

        document.getElementById('steal-loot-btn').onclick = () => {
            if (this.nearbyEnemyCenter) {
                this.socket.emit('steal_loot', { targetUserId: this.nearbyEnemyCenter.user_id });
            }
        };

        const sellFood = async () => {
            const amount = parseInt(document.getElementById('trade-amount').value);
            const res = await fetch('/api/sell-food', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: this.token, amount })
            });
            const data = await res.json();
            if (data.error) alert(data.error);
        };

        const sellWater = async () => {
            const amount = parseInt(document.getElementById('trade-amount-water').value);
            const res = await fetch('/api/sell-water', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ token: this.token, amount })
            });
            const data = await res.json();
            if (data.error) alert(data.error);
        };

        if (document.getElementById('sell-food-btn')) {
            document.getElementById('sell-food-btn').onclick = sellFood;
        }
        if (document.getElementById('sell-water-btn')) {
            document.getElementById('sell-water-btn').onclick = sellWater;
        }

        document.getElementById('find-battle-btn').onclick = () => {
            const targets = this.worldBuildings?.filter(b => b.type === 'main_house' && b.user_id !== this.user.id);
            if (!targets || targets.length === 0) {
                alert("No other kingdoms discovered yet!");
                return;
            }

            // Find nearest city
            let nearest = null;
            let minDist = Infinity;
            targets.forEach(city => {
                const dist = Math.hypot(this.user.x - city.world_x, this.user.y - city.world_y);
                if (dist < minDist) {
                    minDist = dist;
                    nearest = city;
                }
            });

            if (nearest) {
                this.scoutingTarget = nearest;
                alert(`Nearby kingdom of ${nearest.owner} detected! Follow the compass.`);
            }
        };

        const buyProtBtn = document.getElementById('buy-protection-btn');
        if (buyProtBtn) buyProtBtn.remove();

        this.canvas.addEventListener('mousemove', (e) => {
            if (this.currentAction && this.currentAction.type === 'build') {
                const rect = this.canvas.getBoundingClientRect();
                this.mouseX = e.clientX - rect.left;
                this.mouseY = e.clientY - rect.top;
            }
        });

        this.canvas.addEventListener('click', (e) => {
            const rect = this.canvas.getBoundingClientRect();
            const x = e.clientX - rect.left;
            const y = e.clientY - rect.top;

            if (this.currentAction && this.currentAction.type === 'build') {
                const gx = Math.floor(x / 50);
                const gy = Math.floor(y / 50);
                this.socket.emit('build', { type: this.currentAction.buildingType, x: gx, y: gy });
                this.currentAction = null;
                document.querySelectorAll('.build-btn').forEach(b => b.style.borderColor = '');
            } else {
                this.handlePlayerClick(x, y);
            }
        });
    },

    updateStats() {
        if (!this.user) return;
        document.getElementById('gold').textContent = Math.floor(this.user.gold);
        document.getElementById('food').textContent = Math.floor(this.user.food);
        document.getElementById('water').textContent = Math.floor(this.user.water || 0);
        document.getElementById('pop').textContent = this.user.people_count || 0;
        document.getElementById('knights-count').textContent = this.knights.length;

        // Show/Hide Place City button
        const placeBtn = document.getElementById('place-city-btn');
        if (this.user.is_placed) placeBtn.classList.add('hidden');
        else placeBtn.classList.remove('hidden');

        // Render Knight List
        const list = document.getElementById('knight-list');
        list.innerHTML = '';
        this.knights.forEach(k => {
            const item = document.createElement('div');
            item.className = 'knight-item';
            const isSelected = this.selectedKnights.has(k.id);
            item.innerHTML = `
                <div class="knight-header">
                    <input type="checkbox" class="knight-check" ${isSelected ? 'checked' : ''}>
                    <span>${k.name}</span>
                    <span>Lvl ${k.level}</span>
                </div>
                <button class="retrain-btn" data-id="${k.id}">Level Up (${k.level * 100}g)</button>
            `;
            item.querySelector('.knight-check').onchange = (e) => {
                if (e.target.checked) this.selectedKnights.add(k.id);
                else this.selectedKnights.delete(k.id);
            };
            item.querySelector('button').onclick = () => {
                this.socket.emit('retrain_knight', { knightId: k.id });
            };
            list.appendChild(item);
        });

        // Toggle Steal 버튼 visibility
        const stealBtn = document.getElementById('steal-loot-btn');
        if (this.nearbyEnemyCenter) stealBtn.classList.remove('hidden');
        else stealBtn.classList.add('hidden');
    },

    setupControls() {
        window.addEventListener('keydown', (e) => this.keys[e.code] = true);
        window.addEventListener('keyup', (e) => this.keys[e.code] = false);
    },

    handleMovement() {
        if (!this.user) return;
        const speed = 5;
        let moved = false;
        if (this.keys['ArrowUp'] || this.keys['KeyW']) { this.user.y -= speed; moved = true; }
        if (this.keys['ArrowDown'] || this.keys['KeyS']) { this.user.y += speed; moved = true; }
        if (this.keys['ArrowLeft'] || this.keys['KeyA']) { this.user.x -= speed; moved = true; }
        if (this.keys['ArrowRight'] || this.keys['KeyD']) { this.user.x += speed; moved = true; }

        if (moved && Date.now() - this.lastMoveUpdate > 50) {
            this.socket.emit('move', { x: this.user.x, y: this.user.y });
            this.lastMoveUpdate = Date.now();
        }
    },

    setupSocketEvents() {
        this.socket.on('new_city', (city) => {
            if (!this.allCities) this.allCities = [];
            if (!this.allCities.find(c => c.user_id === city.user_id)) {
                this.allCities.push(city);
            }
        });

        this.socket.on('opponent_found', (opponent) => {
            this.currentOpponent = opponent;
            const modal = document.getElementById('battle-modal');
            const target = document.getElementById('battle-target');
            const attackBtn = document.getElementById('attack-btn');

            modal.classList.remove('hidden');
            target.innerHTML = `
                <h3>${opponent.username}</h3>
                <p>Knights: ${opponent.knight_count}</p>
                <p>${opponent.isProtected ? '🛡️ PROTECTED' : '⚔️ VULNERABLE'}</p>
            `;

            if (opponent.isProtected) {
                attackBtn.classList.add('hidden');
            } else {
                attackBtn.classList.remove('hidden');
            }
        });

        this.socket.on('battle_result', (result) => {
            if (result.win) {
                alert(`VICTORY! You looted ${result.lootGold} gold and ${result.lootFood} food!`);
            } else {
                alert(`DEFEAT! Your knights were slaughtered.`);
            }
        });

        this.socket.on('world_building_update', ({ buildingId, health }) => {
            const b = this.buildings.find(b => b.id === buildingId);
            if (b) b.health = health;
            // Also check worldBuildings if implemented
        });

        this.socket.on('error', (msg) => {
            alert(msg);
            if (msg.includes('A new day has passed')) {
                this.dayTimeLeft = 300;
            }
            if (msg.includes('Session expired') || msg.includes('User not found')) {
                localStorage.removeItem('token');
                location.reload();
            }
        });
    },

    updateTimer() {
        this.dayTimeLeft = Math.max(0, this.dayTimeLeft - 1 / 60);
        const mins = Math.floor(this.dayTimeLeft / 60);
        const secs = Math.floor(this.dayTimeLeft % 60);
        document.getElementById('day-timer').querySelector('span').textContent =
            `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    },

    animate() {
        this.handleMovement();
        this.updateTimer();
        this.render();
        // Scouting Indicator
        if (this.scoutingTarget && this.user) {
            const tx = this.scoutingTarget.world_x || this.scoutingTarget.x * 50;
            const ty = this.scoutingTarget.world_y || this.scoutingTarget.y * 50;
            const angle = Math.atan2(ty - this.user.y, tx - this.user.x);

            const ctx = this.ctx;
            ctx.save();
            ctx.translate(this.user.x, this.user.y);
            ctx.rotate(angle);

            // Draw compass arrow
            ctx.fillStyle = '#f87171';
            ctx.beginPath();
            ctx.moveTo(40, 0);
            ctx.lineTo(30, -10);
            ctx.lineTo(30, 10);
            ctx.fill();

            ctx.restore();

            // Check if reached
            const dist = Math.hypot(this.user.x - tx, this.user.y - ty);
            if (dist < 150) {
                this.scoutingTarget = null; // Reached
            }
        }

        requestAnimationFrame(() => this.animate());
    },

    handlePlayerClick(x, y) {
        if (this.isDeconstructMode) {
            const building = this.buildings.find(b => b.x === Math.floor(x / 50) && b.y === Math.floor(y / 50));
            if (building) this.socket.emit('destroy_building', { buildingId: building.id });
        } else if (this.selectedKnights.size > 0) {
            // Find target building at this position (could be an world building)
            const targetBuilding = this.worldBuildings?.find(b => {
                if (b.user_id === this.user.id) return false;
                const cx = b.world_x;
                const cy = b.world_y;
                return x >= cx && x <= cx + 50 && y >= cy && y <= cy + 50;
            });

            if (targetBuilding) {
                this.socket.emit('attack_building', { buildingId: targetBuilding.id, knightIds: Array.from(this.selectedKnights) });
            }
        }
    },

    render() {
        const { ctx, canvas, buildings, user } = this;
        if (!user) return;

        // Update Camera
        this.camera.x = user.x - canvas.width / 2;
        this.camera.y = user.y - canvas.height / 2;

        ctx.clearRect(0, 0, canvas.width, canvas.height);

        ctx.save();
        ctx.translate(-this.camera.x, -this.camera.y);

        // Draw Grid
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
        const startX = Math.floor(this.camera.x / 50) * 50;
        const startY = Math.floor(this.camera.y / 50) * 50;
        for (let x = startX; x < this.camera.x + canvas.width + 50; x += 50) {
            ctx.beginPath(); ctx.moveTo(x, this.camera.y); ctx.lineTo(x, this.camera.y + canvas.height); ctx.stroke();
        }
        for (let y = startY; y < this.camera.y + canvas.height + 50; y += 50) {
            ctx.beginPath(); ctx.moveTo(this.camera.x, y); ctx.lineTo(this.camera.x + canvas.width, y); ctx.stroke();
        }

        // Draw Other Cities (World Map)
        if (this.allCities) {
            this.allCities.forEach(city => {
                const cx = city.world_x;
                const cy = city.world_y;

                ctx.fillStyle = city.user_id === user.id ? '#f59e0b' : '#ef4444';
                ctx.fillRect(cx, cy, 50, 50);
                ctx.strokeStyle = 'white';
                ctx.strokeRect(cx, cy, 50, 50);

                ctx.fillStyle = 'white';
                ctx.font = 'bold 10px Inter';
                ctx.fillText((city.user_id === user.id ? "Your Kingdom" : city.owner + "'s City"), cx + 25, cy - 5);
            });
        }

        // Draw Buildings (Only if placed)
        if (user.is_placed) {
            buildings.forEach(b => {
                const bx = user.city_x + (b.x - 10) * 50;
                const by = user.city_y + (b.y - 10) * 50;

                ctx.fillStyle = b.type === 'house' ? '#4ade80' :
                    b.type === 'farm' ? '#fbbf24' :
                        b.type === 'well' ? '#60a5fa' :
                            b.type === 'wall' ? '#94a3b8' :
                                b.type === 'door' ? (b.state === 'open' ? '#f472b6' : '#db2777') :
                                    b.type === 'cannon' ? '#818cf8' :
                                        b.type === 'main_house' ? '#f59e0b' : '#f87171';

                ctx.fillRect(bx + 8, by + 8, 34, 34);

                if (b.type === 'cannon') {
                    ctx.strokeStyle = 'rgba(129, 140, 248, 0.2)';
                    ctx.beginPath(); ctx.arc(bx + 25, by + 25, 300, 0, Math.PI * 2); ctx.stroke();
                }

                if (b.health < b.max_health) {
                    ctx.fillStyle = 'rgba(0,0,0,0.5)';
                    ctx.fillRect(bx + 5, by + 2, 40, 4);
                    ctx.fillStyle = '#22c55e';
                    ctx.fillRect(bx + 5, by + 2, 40 * (b.health / b.max_health), 4);
                }
            });
        }

        // Draw Player
        ctx.fillStyle = user.is_placed ? '#d4af37' : '#3b82f6';
        ctx.beginPath(); ctx.arc(user.x, user.y, 10, 0, Math.PI * 2); ctx.fill();

        ctx.fillStyle = 'white';
        ctx.font = '12px Inter'; ctx.textAlign = 'center';
        ctx.fillText(user.username + (!user.is_placed ? " (Safe Mode)" : ""), user.x, user.y - 15);

        // Draw Marching Knights
        this.knights.forEach((k, index) => {
            const isSelected = this.selectedKnights.has(k.id);
            if (!isSelected) return;

            const kpos = this.knightPositions[k.id];
            if (kpos) {
                const targetX = user.x - Math.cos(index * 1.0) * 40;
                const targetY = user.y - Math.sin(index * 1.0) * 40;
                kpos.x += (targetX - kpos.x) * 0.1;
                kpos.y += (targetY - kpos.y) * 0.1;

                ctx.fillStyle = '#6366f1';
                ctx.beginPath(); ctx.arc(kpos.x, kpos.y, 8, 0, Math.PI * 2); ctx.fill();

                if (k.health < k.max_health) {
                    ctx.fillStyle = 'rgba(0,0,0,0.5)';
                    ctx.fillRect(kpos.x - 10, kpos.y - 15, 20, 3);
                    ctx.fillStyle = '#22c55e';
                    ctx.fillRect(kpos.x - 10, kpos.y - 15, 20 * (k.health / k.max_health), 3);
                }
            }
        });

        // Nearby Enemy Center Check
        this.nearbyEnemyCenter = null;
        if (this.allCities && user.is_placed) {
            for (const city of this.allCities) {
                if (city.user_id === user.id) continue;
                const dist = Math.hypot(user.x - city.world_x, user.y - city.world_y);
                if (dist < 150) {
                    this.nearbyEnemyCenter = city;
                    break;
                }
            }
        }

        // Draw Others
        Object.values(this.others).forEach(p => {
            ctx.fillStyle = '#94a3b8';
            ctx.beginPath(); ctx.arc(p.x, p.y, 10, 0, Math.PI * 2); ctx.fill();
            ctx.fillStyle = 'white';
            ctx.fillText(p.username, p.x, p.y - 15);
        });

        ctx.restore();

        // UI Overlay (No Camera)
        if (!user.is_placed) {
            ctx.fillStyle = 'rgba(0,0,0,0.6)';
            ctx.fillRect(0, 0, canvas.width, 60);
            ctx.fillStyle = '#3b82f6';
            ctx.font = 'bold 20px Inter';
            ctx.textAlign = 'center';
            ctx.fillText("📍 EXPLORATION MODE: Find a location for your Kingdom!", canvas.width / 2, 40);
        }
        if (this.currentAction && this.currentAction.type === 'build' && this.mouseX !== undefined) {
            const gx = Math.floor(this.mouseX / 50) * 50;
            const gy = Math.floor(this.mouseY / 50) * 50;
            ctx.fillStyle = 'rgba(212, 175, 55, 0.3)';
            ctx.fillRect(gx + 5, gy + 5, 40, 40);
        }
    }
};

app.init();
