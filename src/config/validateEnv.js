module.exports = function validateEnv() {
  const { JWT_SECRET, MONGO_URI } = process.env;

  if (!MONGO_URI) {
    throw new Error('MONGO_URI is missing. Check your .env file.');
  }
  if (!JWT_SECRET || JWT_SECRET.length < 32) {
    throw new Error('JWT_SECRET is missing or too weak (must be >= 32 chars).');
  }
  if (JWT_SECRET === 'lead_manager_secret_2024') {
    throw new Error('JWT_SECRET is still the old leaked value. Rotate it.');
  }
};