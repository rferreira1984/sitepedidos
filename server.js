require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const pedidosRoutes = require('./src/routes/pedidos');
const { testConnection } = require('./src/config/database');

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());

// Servir arquivos estáticos — CORRIGIDO: caminho absoluto a partir de __dirname
app.use(express.static(path.join(__dirname, 'public')));

// API
app.use('/api/pedidos', pedidosRoutes);

// Fallback: qualquer rota não reconhecida → index.html
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, req, res, next) => {
    console.error('Erro:', err.message);
    res.status(500).json({ success: false, message: 'Erro interno' });
});

async function start() {
    const connected = await testConnection();
    if (connected) {
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`Servidor rodando em http://0.0.0.0:${PORT}`);
        });
    } else {
        console.error('Falha no banco');
        process.exit(1);
    }
}
start();
module.exports = app;
