require('dotenv').config();

module.exports = {
  PORT: process.env.PORT || 8765,
  SESSION_SECRET: process.env.SESSION_SECRET || 'narma-crm-dev-secret',
  NODE_ENV: process.env.NODE_ENV || 'development',
  // Días sin pedir a partir de los cuales un cliente entra en estado de alerta
  ALERT_DAYS: 15,
};
