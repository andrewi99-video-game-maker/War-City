const BUILDING_DATA = {
    main_house: { costGold: 0, costFood: 0, health: 500, description: "City Center. Protect this to avoid looting." },
    house: { costGold: 100, costFood: 50, popCapacity: 5, health: 100 },
    farm: { costGold: 150, costFood: 0, foodProduction: 10, workersNeeded: 5, health: 80 },
    well: { costGold: 100, costFood: 0, waterProduction: 16, workersNeeded: 1, health: 80 },
    barracks: { costGold: 200, costFood: 100, knightCapacity: 3, health: 150 },
    wall: { costGold: 50, costFood: 0, health: 300, isObstacle: true },
    door: { costGold: 80, costFood: 0, health: 200, isToggable: true },
    cannon: { costGold: 300, costFood: 50, health: 150, range: 150, damage: 20, fireRate: 2000 }
};

const KNIGHT_COST = { gold: 50, food: 20 };
const REFUND_FACTOR = 0.8; // 4/5 refund

module.exports = { BUILDING_DATA, KNIGHT_COST };
