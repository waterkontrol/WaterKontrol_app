// Detectar si estamos en desarrollo local o producción
const isLocalhost = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1';
const RAILWAY_API_URL = isLocalhost 
  ? 'http://localhost:8081' // URL de tu servidor local
  : 'https://waterkontrolapp-production.up.railway.app'; // URL de producción