require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });
const express = require('express');
const cors = require('cors');
const path = require('path');
const pedidosRoutes = require('./src/routes/pedidos');
const { testConnection } = require('./src/config/database');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos (index.html, styles.css)
app.use(express.static(path.join(__dirname, '..', 'public')));

// API
app.use('/api/pedidos', pedidosRoutes);

// Qualquer rota não reconhecida → index.html (SPA fallback)
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ success: false, message: 'Erro interno do servidor' });
});

async function start() {
    const connected = await testConnection();
    if (connected) {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
        });
    } else {
        console.error('Falha ao conectar no banco. Verifique o .env');
        process.exit(1);
    }
}
start();
module.exports = app;
