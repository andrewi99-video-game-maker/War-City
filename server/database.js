const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');

async function initDb() {
    const db = await open({
        filename: path.join(__dirname, 'game.db'),
        driver: sqlite3.Database
    });

    await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE,
            password TEXT,
            gold INTEGER DEFAULT 1000,
            food INTEGER DEFAULT 500,
            water INTEGER DEFAULT 500,
            people_count INTEGER DEFAULT 5,
            x FLOAT DEFAULT 100.0,
            y FLOAT DEFAULT 100.0,
            city_x FLOAT,
            city_y FLOAT,
            is_placed INTEGER DEFAULT 0,
            last_login DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS buildings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            type TEXT,
            x INTEGER,
            y INTEGER,
            world_x FLOAT,
            world_y FLOAT,
            level INTEGER DEFAULT 1,
            health INTEGER DEFAULT 100,
            max_health INTEGER DEFAULT 100,
            state TEXT DEFAULT 'closed', -- For doors: 'open' or 'closed'
            FOREIGN KEY(user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS knights (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER,
            name TEXT,
            level INTEGER DEFAULT 1,
            health INTEGER DEFAULT 100,
            max_health INTEGER DEFAULT 100,
            barrack_id INTEGER,
            FOREIGN KEY(user_id) REFERENCES users(id),
            FOREIGN KEY(barrack_id) REFERENCES buildings(id)
        );

        CREATE TABLE IF NOT EXISTS protection (
            user_id INTEGER PRIMARY KEY,
            expires_at DATETIME,
            FOREIGN KEY(user_id) REFERENCES users(id)
        );
    `);

    return db;
}

module.exports = { initDb };
