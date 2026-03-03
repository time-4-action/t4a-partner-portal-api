const { generateRechargeXml } = require('../services/recharge.service');

exports.getAllXml = async (req, res) => {
    try {
        const xml = await generateRechargeXml();
        res.setHeader('Content-Type', 'application/xml; charset=utf-8');
        res.send(xml);
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
};
