require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'salgadoscia_secret_key_2026';

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    host: process.env.DB_HOST || '76.13.171.134',
    port: parseInt(process.env.DB_PORT || '5432'),
    user: process.env.DB_USER || 'postgres',
    password: process.env.DB_PASSWORD || 't3vjopnp0wru1pvuzcpx',
    database: process.env.DB_NAME || 'n8n_salgadoscia',
});

async function testConnection() {
    try {
        const res = await pool.query('SELECT NOW()');
        console.log('Conectado ao PostgreSQL em', res.rows[0].now);
        return true;
    } catch (err) {
        console.error('Erro ao conectar no PostgreSQL:', err.message);
        return false;
    }
}

function authMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, message: 'Token não fornecido' });
    }
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.usuario = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token inválido ou expirado' });
    }
}

// ===== ROTAS DE AUTENTICAÇÃO =====

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) {
            return res.status(400).json({ success: false, message: 'Email e senha obrigatórios' });
        }
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
        const usuario = result.rows[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaValida) {
            return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        }
        const token = jwt.sign(
            { id: usuario.id, nome: usuario.nome, email: usuario.email },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        res.json({
            success: true,
            token,
            usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email }
        });
    } catch (err) {
        console.error('Erro no login:', err);
        res.status(500).json({ success: false, message: 'Erro interno do servidor' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome, email, created_at FROM usuarios WHERE id = $1', [req.usuario.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        }
        res.json({ success: true, usuario: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});

// ===== ROTAS DE PEDIDOS =====

app.get('/api/pedidos', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const status = req.query.status || '';

        let where = [];
        let params = [];
        let paramIndex = 1;

        if (search) {
            where.push(`(p.nome_cliente ILIKE $${paramIndex} OR p.items ILIKE $${paramIndex} OR p.telefone ILIKE $${paramIndex} OR CAST(p.id AS TEXT) ILIKE $${paramIndex})`);
            params.push(`%${search}%`);
            paramIndex++;
        }
        if (status) {
            where.push(`p.status = $${paramIndex}`);
            params.push(status);
            paramIndex++;
        }

        const whereClause = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
        const countResult = await pool.query(`SELECT COUNT(*) FROM s_pedidos p ${whereClause}`, params);
        const total = parseInt(countResult.rows[0].count);

        const result = await pool.query(
            `SELECT p.* FROM s_pedidos p ${whereClause} ORDER BY p.data_criacao DESC LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`,
            [...params, limit, offset]
        );

        const statsResult = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'Pendente')::int AS pendentes,
                COUNT(*) FILTER (WHERE status = 'Em Producao')::int AS em_producao,
                COUNT(*) FILTER (WHERE status = 'Em Andamento')::int AS em_andamento,
                COUNT(*) FILTER (WHERE status = 'Entregue')::int AS entregues,
                COUNT(*) FILTER (WHERE status = 'Cancelado')::int AS cancelados
            FROM s_pedidos
        `);

        res.json({
            success: true,
            data: result.rows,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
            stats: statsResult.rows[0]
        });
    } catch (err) {
        console.error('Erro ao listar pedidos:', err);
        res.status(500).json({ success: false, message: 'Erro ao listar pedidos' });
    }
});

app.get('/api/pedidos/:id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        }
        const historico = await pool.query(
            'SELECT sh.*, u.nome AS usuario_nome FROM status_historico sh LEFT JOIN usuarios u ON u.id = sh.usuario_id WHERE sh.pedido_id = $1 ORDER BY sh.created_at DESC',
            [req.params.id]
        );
        res.json({ success: true, data: result.rows[0], historico: historico.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar pedido' });
    }
});

app.put('/api/pedidos/:id/status', authMiddleware, async (req, res) => {
    try {
        const { status, observacao } = req.body;
        const statusValidos = ['Pendente', 'Em Producao', 'Em Andamento', 'Entregue', 'Cancelado'];
        if (!statusValidos.includes(status)) {
            return res.status(400).json({ success: false, message: 'Status inválido' });
        }
        const pedidoAtual = await pool.query('SELECT status FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (pedidoAtual.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        }
        const statusAnterior = pedidoAtual.rows[0].status;
        await pool.query('UPDATE s_pedidos SET status = $1 WHERE id = $2', [status, req.params.id]);
        await pool.query(
            'INSERT INTO status_historico (pedido_id, status_anterior, status_novo, observacao, usuario_id) VALUES ($1, $2, $3, $4, $5)',
            [req.params.id, statusAnterior, status, observacao || null, req.usuario.id]
        );
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        res.json({ success: true, data: result.rows[0], message: `Status atualizado para "${status}"` });
    } catch (err) {
        console.error('Erro ao atualizar status:', err);
        res.status(500).json({ success: false, message: 'Erro ao atualizar status' });
    }
});

app.post('/api/pedidos/:id/mensagem', authMiddleware, async (req, res) => {
    try {
        const { mensagem } = req.body;
        if (!mensagem) {
            return res.status(400).json({ success: false, message: 'Mensagem obrigatória' });
        }
        const pedido = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (pedido.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        }
        const p = pedido.rows[0];
        if (!p.telefone) {
            return res.status(400).json({ success: false, message: 'Pedido não tem telefone cadastrado' });
        }
        await pool.query(
            'INSERT INTO mensagens (pedido_id, telefone, mensagem, enviado_por) VALUES ($1, $2, $3, $4)',
            [req.params.id, p.telefone, mensagem, req.usuario.id]
        );
        res.json({ success: true, message: 'Mensagem registrada com sucesso', data: { telefone: p.telefone, mensagem } });
    } catch (err) {
        console.error('Erro ao registrar mensagem:', err);
        res.status(500).json({ success: false, message: 'Erro ao registrar mensagem' });
    }
});

app.get('/api/pedidos/:id/mensagens', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT m.*, u.nome AS usuario_nome FROM mensagens m LEFT JOIN usuarios u ON u.id = m.enviado_por WHERE m.pedido_id = $1 ORDER BY m.created_at DESC',
            [req.params.id]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar mensagens' });
    }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                COUNT(*)::int AS total,
                COUNT(*) FILTER (WHERE status = 'Pendente')::int AS pendentes,
                COUNT(*) FILTER (WHERE status = 'Em Producao')::int AS em_producao,
                COUNT(*) FILTER (WHERE status = 'Em Andamento')::int AS em_andamento,
                COUNT(*) FILTER (WHERE status = 'Entregue')::int AS entregues,
                COUNT(*) FILTER (WHERE status = 'Cancelado')::int AS cancelados,
                COALESCE(SUM(valor_total) FILTER (WHERE status != 'Cancelado'), 0)::numeric(10,2) AS faturamento_total,
                COALESCE(SUM(valor_total) FILTER (WHERE status = 'Entregue'), 0)::numeric(10,2) AS faturamento_entregue
            FROM s_pedidos
        `);
        const hoje = await pool.query(`
            SELECT COUNT(*)::int AS pedidos_hoje, COALESCE(SUM(valor_total), 0)::numeric(10,2) AS faturamento_hoje
            FROM s_pedidos WHERE DATE(data_criacao) = CURRENT_DATE
        `);
        res.json({ success: true, stats: result.rows[0], hoje: hoje.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar stats' });
    }
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
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