const { getDb } = require('../services/db/mongo.service');

const checkDatabase = async () => {
    try {
        const db = getDb();
        // Pinging the database is a lightweight operation to check the connection.
        await db.admin().ping();
        return 'ok';
    } catch (error) {
        console.error('Database health check failed:', error);
        return 'error';
    }
};

const checkDependencies = async () => {
    const dbStatus = await checkDatabase();
    return {
        database: dbStatus,
        // Future dependencies can be checked here
    };
};

module.exports = { checkDependencies };
