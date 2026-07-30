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
    if (!authHeader) return res.status(401).json({ success: false, message: 'Token não fornecido' });
    const token = authHeader.split(' ')[1];
    try {
        req.usuario = jwt.verify(token, JWT_SECRET);
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token inválido ou expirado' });
    }
}

// ==================== ROTAS PÚBLICAS ====================

// GET /api/categorias
app.get('/api/categorias', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, slug, description, display_order FROM s_categories ORDER BY display_order');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Erro ao buscar categorias:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar categorias' });
    }
});

// GET /api/produtos - com preços
app.get('/api/produtos', async (req, res) => {
    try {
        const { categoria } = req.query;
        let productQuery = 'SELECT p.*, c.name AS categoria_nome, c.display_order AS cat_order FROM s_products p JOIN s_categories c ON c.id = p.category_id WHERE p.is_active = true';
        let params = [];
        if (categoria) {
            productQuery += ' AND c.name = $1';
            params.push(categoria);
        }
        productQuery += ' ORDER BY c.display_order, p.display_order, p.name';

        const products = await pool.query(productQuery, params);
        const result = [];

        for (const p of products.rows) {
            const prices = await pool.query(
                'SELECT id, price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras FROM s_product_prices WHERE product_id = $1 AND is_active = true ORDER BY price_type, quantity',
                [p.id]
            );
            result.push({ ...p, prices: prices.rows });
        }

        res.json({ success: true, data: result });
    } catch (err) {
        console.error('Erro ao buscar produtos:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar produtos' });
    }
});

// GET /api/produtos/:id
app.get('/api/produtos/:id', async (req, res) => {
    try {
        const product = await pool.query(
            'SELECT p.*, c.name AS categoria_nome FROM s_products p JOIN s_categories c ON c.id = p.category_id WHERE p.id = $1',
            [req.params.id]
        );
        if (product.rows.length === 0) return res.status(404).json({ success: false, message: 'Produto não encontrado' });
        const prices = await pool.query(
            'SELECT * FROM s_product_prices WHERE product_id = $1 AND is_active = true ORDER BY price_type, quantity',
            [req.params.id]
        );
        res.json({ success: true, data: { ...product.rows[0], prices: prices.rows } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar produto' });
    }
});

// POST /api/pedidos - Cliente cria pedido
app.post('/api/pedidos', async (req, res) => {
    try {
        const { nome_cliente, telefone, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, items, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, observacoes } = req.body;
        if (!nome_cliente || !telefone || !items || !valor_total) {
            return res.status(400).json({ success: false, message: 'Nome, telefone, items e valor total são obrigatórios' });
        }
        const result = await pool.query(
            `INSERT INTO s_pedidos (nome_cliente, telefone, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, items, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, observacoes, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'Pendente') RETURNING *`,
            [nome_cliente, telefone, endereco_rua || '', endereco_numero || '', endereco_bairro || '', endereco_cep || '', items, valor_total, taxa_entrega || 0, forma_pagamento || '', tipo_logistica || '', observacoes || '']
        );
        res.status(201).json({ success: true, data: result.rows[0], message: 'Pedido criado com sucesso!' });
    } catch (err) {
        console.error('Erro ao criar pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao criar pedido' });
    }
});

// ==================== ROTAS DE AUTENTICAÇÃO ====================

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, senha } = req.body;
        if (!email || !senha) return res.status(400).json({ success: false, message: 'Email e senha obrigatórios' });
        const result = await pool.query('SELECT * FROM usuarios WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        const usuario = result.rows[0];
        const senhaValida = await bcrypt.compare(senha, usuario.senha_hash);
        if (!senhaValida) return res.status(401).json({ success: false, message: 'Credenciais inválidas' });
        const token = jwt.sign({ id: usuario.id, nome: usuario.nome, email: usuario.email }, JWT_SECRET, { expiresIn: '24h' });
        res.json({ success: true, token, usuario: { id: usuario.id, nome: usuario.nome, email: usuario.email } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro interno do servidor' });
    }
});

app.get('/api/auth/me', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT id, nome, email, created_at FROM usuarios WHERE id = $1', [req.usuario.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Usuário não encontrado' });
        res.json({ success: true, usuario: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro interno' });
    }
});

// ==================== ROTAS ADMIN (PROTEGIDAS) ====================

app.get('/api/pedidos', authMiddleware, async (req, res) => {
    try {
        const page = parseInt(req.query.page) || 1;
        const limit = parseInt(req.query.limit) || 20;
        const offset = (page - 1) * limit;
        const search = req.query.search || '';
        const status = req.query.status || '';
        let where = [], params = [], pi = 1;
        if (search) {
            where.push(`(p.nome_cliente ILIKE $${pi} OR p.items ILIKE $${pi} OR p.telefone ILIKE $${pi} OR CAST(p.id AS TEXT) ILIKE $${pi})`);
            params.push(`%${search}%`); pi++;
        }
        if (status) { where.push(`p.status = $${pi}`); params.push(status); pi++; }
        const wc = where.length > 0 ? 'WHERE ' + where.join(' AND ') : '';
        const count = await pool.query(`SELECT COUNT(*) FROM s_pedidos p ${wc}`, params);
        const total = parseInt(count.rows[0].count);
        const result = await pool.query(`SELECT p.* FROM s_pedidos p ${wc} ORDER BY p.data_criacao DESC LIMIT $${pi} OFFSET $${pi+1}`, [...params, limit, offset]);
        const stats = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='Pendente')::int AS pendentes, COUNT(*) FILTER (WHERE status='Em Producao')::int AS em_producao, COUNT(*) FILTER (WHERE status='Em Andamento')::int AS em_andamento, COUNT(*) FILTER (WHERE status='Entregue')::int AS entregues, COUNT(*) FILTER (WHERE status='Cancelado')::int AS cancelados FROM s_pedidos`);
        res.json({ success: true, data: result.rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }, stats: stats.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao listar pedidos' });
    }
});

app.get('/api/pedidos/:id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const historico = await pool.query('SELECT sh.*, u.nome AS usuario_nome FROM status_historico sh LEFT JOIN usuarios u ON u.id = sh.usuario_id WHERE sh.pedido_id = $1 ORDER BY sh.created_at DESC', [req.params.id]);
        res.json({ success: true, data: result.rows[0], historico: historico.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar pedido' });
    }
});

app.put('/api/pedidos/:id/status', authMiddleware, async (req, res) => {
    try {
        const { status, observacao } = req.body;
        const validos = ['Pendente', 'Em Producao', 'Em Andamento', 'Entregue', 'Cancelado'];
        if (!validos.includes(status)) return res.status(400).json({ success: false, message: 'Status inválido' });
        const atual = await pool.query('SELECT status FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (atual.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const antigo = atual.rows[0].status;
        await pool.query('UPDATE s_pedidos SET status = $1 WHERE id = $2', [status, req.params.id]);
        await pool.query('INSERT INTO status_historico (pedido_id, status_anterior, status_novo, observacao, usuario_id) VALUES ($1,$2,$3,$4,$5)', [req.params.id, antigo, status, observacao || null, req.usuario.id]);
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        res.json({ success: true, data: result.rows[0], message: `Status atualizado para "${status}"` });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao atualizar status' });
    }
});

app.post('/api/pedidos/:id/mensagem', authMiddleware, async (req, res) => {
    try {
        const { mensagem } = req.body;
        if (!mensagem) return res.status(400).json({ success: false, message: 'Mensagem obrigatória' });
        const pedido = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (pedido.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const p = pedido.rows[0];
        if (!p.telefone) return res.status(400).json({ success: false, message: 'Pedido não tem telefone' });
        await pool.query('INSERT INTO mensagens (pedido_id, telefone, mensagem, enviado_por) VALUES ($1,$2,$3,$4)', [req.params.id, p.telefone, mensagem, req.usuario.id]);
        res.json({ success: true, message: 'Mensagem registrada', data: { telefone: p.telefone, mensagem } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao registrar mensagem' });
    }
});

app.get('/api/stats', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query(`SELECT COUNT(*)::int AS total, COUNT(*) FILTER (WHERE status='Pendente')::int AS pendentes, COUNT(*) FILTER (WHERE status='Em Producao')::int AS em_producao, COUNT(*) FILTER (WHERE status='Em Andamento')::int AS em_andamento, COUNT(*) FILTER (WHERE status='Entregue')::int AS entregues, COUNT(*) FILTER (WHERE status='Cancelado')::int AS cancelados, COALESCE(SUM(valor_total) FILTER (WHERE status!='Cancelado'),0)::numeric(10,2) AS faturamento_total, COALESCE(SUM(valor_total) FILTER (WHERE status='Entregue'),0)::numeric(10,2) AS faturamento_entregue FROM s_pedidos`);
        const hoje = await pool.query(`SELECT COUNT(*)::int AS pedidos_hoje, COALESCE(SUM(valor_total),0)::numeric(10,2) AS faturamento_hoje FROM s_pedidos WHERE DATE(data_criacao)=CURRENT_DATE`);
        res.json({ success: true, stats: result.rows[0], hoje: hoje.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar stats' });
    }
});

// CRUD Produtos (admin)
app.post('/api/produtos', authMiddleware, async (req, res) => {
    try {
        const { name, description, category_id, icone, is_active, display_order } = req.body;
        const result = await pool.query('INSERT INTO s_products (name, description, category_id, is_active, display_order) VALUES ($1,$2,$3,$4,$5) RETURNING *', [name, description, category_id, is_active !== false, display_order || 0]);
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao criar produto' });
    }
});

app.put('/api/produtos/:id', authMiddleware, async (req, res) => {
    try {
        const { name, description, category_id, is_active, display_order } = req.body;
        const result = await pool.query('UPDATE s_products SET name=$1, description=$2, category_id=$3, is_active=$4, display_order=$5 WHERE id=$6 RETURNING *', [name, description, category_id, is_active, display_order, req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Produto não encontrado' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao atualizar produto' });
    }
});

app.delete('/api/produtos/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM s_product_prices WHERE product_id = $1', [req.params.id]);
        await pool.query('DELETE FROM s_products WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Produto removido' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao remover produto' });
    }
});

// CRUD Preços (admin)
app.post('/api/precos', authMiddleware, async (req, res) => {
    try {
        const { product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras } = req.body;
        const result = await pool.query(
            'INSERT INTO s_product_prices (product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
            [product_id, price_type, quantity, unit_label, label, price, opcoes || '', composicao || '', regras || '']
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao criar preço' });
    }
});

app.put('/api/precos/:id', authMiddleware, async (req, res) => {
    try {
        const { price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras } = req.body;
        const result = await pool.query(
            'UPDATE s_product_prices SET price_type=$1, quantity=$2, unit_label=$3, label=$4, price=$5, is_active=$6, opcoes=$7, composicao=$8, regras=$9 WHERE id=$10 RETURNING *',
            [price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Preço não encontrado' });
        res.json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao atualizar preço' });
    }
});

app.delete('/api/precos/:id', authMiddleware, async (req, res) => {
    try {
        await pool.query('DELETE FROM s_product_prices WHERE id = $1', [req.params.id]);
        res.json({ success: true, message: 'Preço removido' });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao remover preço' });
    }
});

// ==================== FALLBACK SPA ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== INICIAR ====================
async function start() {
    const connected = await testConnection();
    if (connected) {
        app.listen(PORT, '0.0.0.0', () => console.log(`Servidor rodando em http://0.0.0.0:${PORT}`));
    } else {
        console.error('Falha no banco');
        process.exit(1);
    }
}
start();
module.exports = app;