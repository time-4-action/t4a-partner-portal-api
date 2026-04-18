const saveAnalyticsData = async (logData) => {
    // MongoDB write removed — analytics collection dropped
};

const monitorFunction = async (fn, actionName, metadata = {}) => {
    // 1. Start timer (returns BigInt in nanoseconds)
    const start = process.hrtime.bigint();
    
    let success = true;
    let result;
    let errorDetails = null;

    try {
        result = await fn();
        return result;
    } catch (error) {
        success = false;
        errorDetails = error.message;
        throw error;
    } finally {
        // 2. End timer and calculate difference
        const end = process.hrtime.bigint();
        const durationNs = end - start; // Result is in nanoseconds (BigInt)

        const analyticsData = {
            app: process.env.APP_NAME,
            type: "function",
            action: actionName,
            ts: new Date(), // Keep wall-clock time for "when" it happened
            
            // Metrics
            durationNs: Number(durationNs.toString()),
            
            metadata,
            success,
            error: errorDetails
        };

        // Asynchronously write to the database, but don't block the final return/throw
        saveAnalyticsData(analyticsData);
    }
};

module.exports = {
    saveAnalyticsData,
    monitorFunction
};