/**
 * Environmental Monitoring & Disaster Risk Analytics - Server
 * Same API/calculation method as: github.com/sujin123456-max/India-specific-tsunami-early-warning-system
 */

const path = require('path');
const express = require('express');
const cors = require('cors');
const { loadConfig } = require('./src/configLoader');
const apiRoutes = require('./src/api/routes');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, 'config', 'config.yaml');
const PORT = parseInt(process.env.PORT, 10) || 5000;

const config = loadConfig(CONFIG_PATH);
const app = express();

app.use(cors());
app.use(express.json());
app.set('config', config);

app.use(express.static(path.join(__dirname, 'public')));
app.use('/api', apiRoutes);

app.get('/health', (req, res) => {
  res.json({ status: 'healthy', service: 'envo-science-disaster-risk' });
});

app.get('/', (req, res) => {
  res.send(`
    <!DOCTYPE html>
    <html>
      <head><title>Environmental Disaster Risk - API</title></head>
      <body>
        <h1>Environmental Monitoring & Disaster Risk Analytics</h1>
        <p>API is running. Same pattern as <a href="https://github.com/sujin123456-max/India-specific-tsunami-early-warning-system">India Tsunami Early Warning System</a>.</p>
        <ul>
          <li><a href="/api/status">GET /api/status</a> - System status</li>
          <li><a href="/api/current-assessment">GET /api/current-assessment</a> - Latest risk assessment</li>
          <li>POST /api/run-check - Trigger one risk check</li>
          <li>POST /api/monitoring/start - Start real-time monitoring</li>
          <li>POST /api/monitoring/stop - Stop monitoring</li>
          <li><a href="/api/rainfall">GET /api/rainfall</a> - Rainfall data (Open-Meteo)</li>
          <li><a href="/api/earthquake/recent">GET /api/earthquake/recent</a> - Recent earthquakes (USGS)</li>
          <li><a href="/api/alert-history">GET /api/alert-history</a> - Alert history</li>
          <li><a href="/api/risk/info">GET /api/risk/info</a> - Risk thresholds & formula</li>
          <li><a href="/api/environment/overview">GET /api/environment/overview</a> - Open API environmental snapshot</li>
          <li><a href="/api/environment/sources">GET /api/environment/sources</a> - Active data-source status</li>
          <li><a href="/api/water/reservoirs">GET /api/water/reservoirs</a> - Reservoir/water levels (NWDP/generic)</li>
        </ul>
        <p>Dashboard: run the React app (see README) or use these endpoints in your frontend.</p>
      </body>
    </html>
  `);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('='.repeat(60));
  console.log('ENVIRONMENTAL MONITORING & DISASTER RISK ANALYTICS');
  console.log('='.repeat(60));
  console.log(`Port: ${PORT}`);
  console.log(`Config: ${CONFIG_PATH}`);
  console.log('Endpoints: /api/status, /api/current-assessment, POST /api/run-check, /api/rainfall, /api/earthquake/recent');
  console.log('='.repeat(60));
});
