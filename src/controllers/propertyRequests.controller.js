const mongoose = require('mongoose');

function getCollection() {
  if (mongoose.connection.readyState !== 1) {
    const err = new Error('Database is not connected');
    err.status = 503;
    throw err;
  }
  return mongoose.connection.db.collection('request_notif');
}

// GET /api/property-requests?status=pending
exports.listPropertyRequests = async (req, res, next) => {
  try {
    const status = String(req.query.status || 'pending').trim().toLowerCase();
    if (!['pending', 'complete', 'completed', 'all'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status filter' });
    }

    const filter = status === 'all' ? {} : { status };
    const documents = await getCollection()
      .find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .limit(500)
      .toArray();

    return res.json({
      success: true,
      count: documents.length,
      data: documents.map((doc) => ({
        ...doc,
        _id: String(doc._id),
        id: String(doc._id),
        requestId: doc.requestId || null,
      })),
    });
  } catch (err) {
    next(err);
  }
};

// PATCH /api/property-requests/:requestId/complete
exports.completePropertyRequest = async (req, res, next) => {
  try {
    const requestId = String(req.params.requestId || '').trim();
    if (!requestId || requestId.length > 160) {
      return res.status(400).json({ message: 'Valid requestId is required' });
    }

    const result = await getCollection().updateOne(
      { requestId },
      { $set: { status: 'complete', completedAt: new Date(), completedBy: String(req.user?._id || '') } }
    );

    if (result.matchedCount === 0) {
      return res.status(404).json({ message: 'Property request not found' });
    }

    return res.json({
      success: true,
      requestId,
      status: 'complete',
      modified: result.modifiedCount > 0,
    });
  } catch (err) {
    next(err);
  }
};
