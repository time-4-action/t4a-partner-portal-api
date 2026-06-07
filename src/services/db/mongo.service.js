const { MongoClient } = require('mongodb');

/**
 * @typedef {mongodb.Db} MongoDb
 */

/**
 * MongoDB connection URI.
 * @type {string}
 */
const mongoUri = process.env.MONGO_URI;
/**
 * MongoDB database name.
 * @type {string}
 */
const dbName = process.env.MONGO_DB_NAME;

if (!mongoUri || !dbName) {
    throw new Error('MONGO_URI and MONGO_DB_NAME must be set in environment variables.');
}

// authSource comes from MONGO_URI (e.g. `?authSource=admin`). Do not override it
// here with dbName — that points auth at the wrong database and breaks login.
const client = new MongoClient(mongoUri);
/**
 * @type {MongoDb}
 */
let db;

/**
 * Connects to the MongoDB database.
 * It's recommended to call this once when the application starts.
 * @returns {Promise<void>} A promise that resolves when the connection is established.
 */
const connectToDb = async () => {
    if (db) {
        return;
    }
    try {
        await client.connect();
        db = client.db(dbName);
        console.log('Successfully connected to MongoDB.');
    } catch (error) {
        console.error('Failed to connect to MongoDB', error);
        process.exit(1); // Exit if we can't connect to the DB
    }
};

/**
 * Returns the database instance. Throws an error if not connected.
 * @returns {MongoDb} The MongoDB database instance.
 */
const getDb = () => {
    if (!db) {
        throw new Error('Database not initialized. Call connectToDb first.');
    }
    return db;
};

module.exports = { connectToDb, getDb };
