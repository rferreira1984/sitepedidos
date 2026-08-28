require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 80;
const JWT_SECRET = process.env.JWT_SECRET || 'salgadoscia_secret_key_2026';
const SITE_URL = process.env.SITE_URL || 'http://localhost:3001';
const WEBHOOK_CONFIRMACAO = process.env.WEBHOOK_CONFIRMACAO || 'https://n8n-salgadoscia-n8n.hjs9cn.easypanel.host/webhook/27084bb2-983f-45b7-8a91-f3627a1704b7';
const WEBHOOK_VERIFICACAO = process.env.WEBHOOK_VERIFICACAO || 'https://n8n-salgadoscia-n8n.hjs9cn.easypanel.host/webhook/9764c692-0c00-4308-b490-6807e2816662';

const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDcy5vIhEOUAeVLBZ9S8pmv8zeOz6NQ8-A';
const LOJA_ORIGEM = '-24.965348589309297,-53.51220562301614';
const TAXA_BASE_ENTREGA = parseFloat(process.env.TAXA_BASE_ENTREGA || '5');
const TAXA_POR_KM = parseFloat(process.env.TAXA_POR_KM || '0');
const FRETE_GRATIS_ACIMA = parseFloat(process.env.FRETE_GRATIS_ACIMA || '0');

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const pool = new Pool({
    host: process.env.DB_HOST || '76.13.171.134',
    port: parseInt(process.env.DB_PORT || '5433'),
    user: process.env.DB_USER || 'infodba',
    password: process.env.DB_PASSWORD || 'infodba',
    database: process.env.DB_NAME || 'db_sistema',
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

app.get('/api/categorias', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, slug, description, display_order FROM s_categories ORDER BY display_order');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Erro ao buscar categorias:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar categorias' });
    }
});

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
                'SELECT id, price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, regras_quantidades FROM s_product_prices WHERE product_id = $1 AND is_active = true ORDER BY price_type, quantity',
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

// POST /api/pedidos - Cliente cria pedido (com opção de link de confirmação)
app.post('/api/pedidos', async (req, res) => {
    try {
        const { nome_cliente, telefone, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, items, itens, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, observacoes, data_entrega, hora_entrega, cliente_id, confirmar_whatsapp } = req.body;
        if (!nome_cliente || !telefone || !items || !valor_total) {
            return res.status(400).json({ success: false, message: 'Nome, telefone, items e valor total são obrigatórios' });
        }

        let dataEntrega = data_entrega || null;
        let horaEntrega = hora_entrega || null;
        if (dataEntrega && String(dataEntrega).includes('T')) dataEntrega = String(dataEntrega).substring(0, 10);
        if (horaEntrega && String(horaEntrega).includes('T')) horaEntrega = String(horaEntrega).substring(11, 16);
        if (horaEntrega && horaEntrega.length > 5) horaEntrega = horaEntrega.substring(0, 5);

        const statusInicial = (confirmar_whatsapp && !cliente_id) ? 'Aguardando Confirmacao' : 'Pendente';
        
        const result = await pool.query(
            `INSERT INTO s_pedidos (nome_cliente, telefone, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, items, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, observacoes, data_entrega, hora_entrega, cliente_id, status)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
            [nome_cliente, telefone, endereco_rua || '', endereco_numero || '', endereco_bairro || '', endereco_cep || '', items, valor_total, taxa_entrega || 0, forma_pagamento || '', tipo_logistica || '', observacoes || '', dataEntrega, horaEntrega, cliente_id || null, statusInicial]
        );

        const pedido = result.rows[0];

        // Gravar itens do pedido na tabela de vínculo (pedido_itens)
        if (Array.isArray(itens) && itens.length > 0) {
            for (const item of itens) {
                await pool.query(
                    `INSERT INTO pedido_itens (pedido_id, product_id, product_name, label, quantidade, preco_unitario, preco_total, descricao)
                     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
                    [
                        pedido.id,
                        item.product_id || null,
                        item.nome || '',
                        item.label || '',
                        parseInt(item.quantidade) || 1,
                        parseFloat(item.preco_unitario) || 0,
                        parseFloat(item.preco_total) || 0,
                        item.descricao || null
                    ]
                );
            }
        }

        // Se pediu confirmação por link: gera token e retorna o link (sem enviar WhatsApp por enquanto)
        if (confirmar_whatsapp) {
            const token = crypto.randomBytes(32).toString('hex');
            
            const expiraEm = new Date(Date.now() + 30 * 60 * 1000); // 30 min
            await pool.query(
                'INSERT INTO tokens_confirmacao (pedido_id, telefone, token, expira_em) VALUES ($1,$2,$3,$4)',
                [pedido.id, telefone, token, expiraEm]
            );
            const link = `${SITE_URL}/confirmar.html?token=${token}`;
            // Enviar link para o webhook (n8n)
            await enviarWebhookConfirmacao(link, telefone, nome_cliente);
            return res.status(201).json({ success: true, data: pedido, link_confirmacao: link, message: 'Pedido criado! Confirme pelo link.' });
        }

        res.status(201).json({ success: true, data: pedido, message: 'Pedido criado com sucesso!' });
    } catch (err) {
        console.error('Erro ao criar pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao criar pedido' });
    }
});
// Calcular custo de entrega (Google Distance Matrix)
app.post('/api/entrega/calcular', async (req, res) => {
    try {
        const { endereco, subtotal } = req.body;
        if (!endereco) return res.status(400).json({ success: false, message: 'Endereço obrigatório' });
        const resultado = await calcularCustoEntrega(endereco, subtotal || 0);
        if (resultado.erro) return res.status(400).json({ success: false, message: resultado.erro });
        res.json({ success: true, data: resultado });
    } catch (err) {
        console.error('Erro ao calcular entrega:', err);
        res.status(500).json({ success: false, message: 'Erro ao calcular entrega' });
    }
});

// Confirmar pedido pelo link (público)
app.get('/api/pedidos/confirmar/:token', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT tc.*, p.status FROM tokens_confirmacao tc
             JOIN s_pedidos p ON p.id = tc.pedido_id
             WHERE tc.token = $1`,
            [req.params.token]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Link inválido ou expirado. Solicite um novo link.' });
        }
        const token = result.rows[0];

        // Já confirmado antes — não é erro, é aviso
        if (token.confirmado) {
            return res.json({ success: true, message: 'Este pedido já foi confirmado anteriormente!', pedido_id: token.pedido_id });
        }

        // Expirado
        if (new Date(token.expira_em) < new Date()) {
            return res.status(400).json({ success: false, message: 'Link expirado. Faça um novo pedido ou solicite outro link.' });
        }

        await pool.query('UPDATE tokens_confirmacao SET confirmado = true WHERE id = $1', [token.id]);
        await pool.query('UPDATE s_pedidos SET status = $1 WHERE id = $2', ['Pendente', token.pedido_id]);
        await pool.query(
            'INSERT INTO status_historico (pedido_id, status_anterior, status_novo, observacao) VALUES ($1,$2,$3,$4)',
            [token.pedido_id, 'Aguardando Confirmacao', 'Pendente', 'Confirmado pelo link']
        );
        res.json({ success: true, message: 'Pedido confirmado com sucesso!', pedido_id: token.pedido_id });
    } catch (err) {
        console.error('Erro ao confirmar pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao confirmar pedido' });
    }
});

async function enviarWebhookConfirmacao(link, telefone, nome) {
    try {
        const res = await fetch(WEBHOOK_CONFIRMACAO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telefone:telefone,
                nome:nome,
                mensagem: 'Clique no link para abaixo para Confirmar seu Pedido',
                link: link
            })
        });
        console.log('Webhook de confirmação enviado:', res.status);
        return true;
    } catch (err) {
        console.error('Erro ao enviar webhook:', err.message);
        return false;
    }
}
async function enviarWebhookVerificacao(numero, codigo) {
    try {
        const res = await fetch(WEBHOOK_VERIFICACAO, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                mensagem: `Seu código de verificação é ${codigo}`,
                numero: numero,
                codigo: codigo
            })
        });
        console.log('Webhook de verificação enviado:', res.status);
        return true;
    } catch (err) {
        console.error('Erro ao enviar webhook de verificação:', err.message);
        return false;
    }
}
async function calcularCustoEntrega(endereco, subtotal) {
    if (!GOOGLE_MAPS_API_KEY) {
        return { erro: 'API do Google Maps não configurada' };
    }
    const url = `https://maps.googleapis.com/maps/api/distancematrix/json?origins=${encodeURIComponent(LOJA_ORIGEM)}&destinations=${encodeURIComponent(endereco)}&key=${GOOGLE_MAPS_API_KEY}&mode=driving&language=pt-BR`;
    const res = await fetch(url);
    const json = await res.json();
    if (json.status !== 'OK' || !json.rows || !json.rows[0] || !json.rows[0].elements || !json.rows[0].elements[0]) {
        return { erro: 'Não foi possível calcular a distância' };
    }
    const element = json.rows[0].elements[0];
    if (element.status !== 'OK') {
        return { erro: 'Endereço não encontrado' };
    }
    const distanciaKm = element.distance.value / 1000;
    let custo = TAXA_BASE_ENTREGA + (distanciaKm * TAXA_POR_KM);
    // Frete grátis acima do valor configurado (se ativado)
    if (FRETE_GRATIS_ACIMA > 0 && subtotal >= FRETE_GRATIS_ACIMA) {
        custo = 0;
    }
    custo = Math.round(custo * 100) / 100;
    return {
        distancia_km: Math.round(distanciaKm * 100) / 100,
        custo_entrega: custo,
        distancia_texto: element.distance.text,
        duracao_texto: element.duration.text
    };
}
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


// ==================== AUTENTICAÇÃO DO CLIENTE (login telefone + senha) ====================

app.post('/api/auth/cliente/registrar', async (req, res) => {
    try {
        const { nome, telefone, senha } = req.body;
        if (!nome || !telefone || !senha) {
            return res.status(400).json({ success: false, message: 'Nome, telefone e senha são obrigatórios' });
        }
        const telefoneLimpo = telefone.replace(/\D/g, '');
        if (telefoneLimpo.length < 10) {
            return res.status(400).json({ success: false, message: 'Telefone inválido' });
        }
        const existente = await pool.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneLimpo]);
        if (existente.rows.length > 0) {
            return res.status(400).json({ success: false, message: 'Este telefone já está cadastrado. Faça login.' });
        }
        const senhaHash = await bcrypt.hash(senha, 10);
        const result = await pool.query(
            'INSERT INTO clientes (nome, telefone, senha_hash) VALUES ($1, $2, $3) RETURNING id, nome, telefone',
            [nome, telefoneLimpo, senhaHash]
        );
        const token = jwt.sign({ id: result.rows[0].id, tipo: 'cliente' }, JWT_SECRET, { expiresIn: '30d' });
        res.status(201).json({ success: true, token, cliente: result.rows[0], message: 'Conta criada!' });
    } catch (err) {
        console.error('Erro ao registrar cliente:', err);
        res.status(500).json({ success: false, message: 'Erro ao registrar' });
    }
});

app.post('/api/auth/cliente/login', async (req, res) => {
    try {
        const { telefone, senha } = req.body;
        if (!telefone || !senha) {
            return res.status(400).json({ success: false, message: 'Telefone e senha são obrigatórios' });
        }
        const telefoneLimpo = telefone.replace(/\D/g, '');
        const result = await pool.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneLimpo]);
        if (result.rows.length === 0) {
            return res.status(401).json({ success: false, message: 'Telefone não cadastrado' });
        }
        const cliente = result.rows[0];
        const senhaValida = await bcrypt.compare(senha, cliente.senha_hash);
        if (!senhaValida) {
            return res.status(401).json({ success: false, message: 'Senha incorreta' });
        }
        const token = jwt.sign({ id: cliente.id, tipo: 'cliente' }, JWT_SECRET, { expiresIn: '30d' });
        res.json({ success: true, token, cliente: { id: cliente.id, nome: cliente.nome, telefone: cliente.telefone } });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro no login' });
    }
});
app.post('/api/auth/cliente/enviar-codigo', async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) return res.status(400).json({ success: false, message: 'Telefone obrigatório' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');  // <-- garantir limpeza
        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });

        const codigo = String(Math.floor(1000 + Math.random() * 9000));
        const expiraEm = new Date(Date.now() + 5 * 60 * 1000);

        await pool.query('UPDATE codigos_verificacao SET usado = true WHERE telefone = $1', [telefoneLimpo]);
        await pool.query(`INSERT INTO codigos_verificacao (telefone, codigo, expira_em)
                        VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
                        [telefoneLimpo, codigo]);
        

        await enviarWebhookVerificacao(telefoneLimpo, codigo);
        res.json({ success: true, message: 'Código enviado para seu WhatsApp!' });
    } catch (err) {
        console.error('Erro ao enviar código:', err);
        res.status(500).json({ success: false, message: 'Erro ao enviar código' });
    }
});
// Validar código de verificação
app.post('/api/auth/cliente/validar-codigo', async (req, res) => {
    try {
        const { telefone, codigo } = req.body;
        if (!telefone || !codigo) return res.status(400).json({ success: false, message: 'Telefone e código são obrigatórios' });

        // Normalizar telefone (só dígitos) e código (string de 4 dígitos)
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const codigoLimpo = String(codigo).replace(/\D/g, '');

        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });
        if (codigoLimpo.length !== 4) return res.status(400).json({ success: false, message: 'Código deve ter 4 dígitos' });

        // Buscar o código mais recente não usado e não expirado
        const result = await pool.query(
            `SELECT * FROM codigos_verificacao
             WHERE telefone = $1 AND codigo = $2 AND usado = false AND expira_em > NOW()
             ORDER BY id DESC LIMIT 1`,
            [telefoneLimpo, codigoLimpo]
        );

        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Código inválido ou expirado' });
        }

        await pool.query('UPDATE codigos_verificacao SET usado = true WHERE id = $1', [result.rows[0].id]);
        res.json({ success: true, message: 'Código validado!' });
    } catch (err) {
        console.error('Erro ao validar código:', err);
        res.status(500).json({ success: false, message: 'Erro ao validar código' });
    }
});

// Recuperar senha - enviar código (telefone deve estar cadastrado)
app.post('/api/auth/cliente/recuperar-enviar-codigo', async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) return res.status(400).json({ success: false, message: 'Telefone obrigatório' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });

        const existente = await pool.query('SELECT * FROM clientes WHERE telefone = $1', [telefoneLimpo]);
        if (existente.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Telefone não cadastrado. Crie uma conta primeiro.' });
        }

        const codigo = String(Math.floor(1000 + Math.random() * 9000));
        await pool.query('UPDATE codigos_verificacao SET usado = true WHERE telefone = $1', [telefoneLimpo]);
        await pool.query(
            `INSERT INTO codigos_verificacao (telefone, codigo, expira_em)
             VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
            [telefoneLimpo, codigo]
        );

        await enviarWebhookVerificacao(telefoneLimpo, codigo);
        res.json({ success: true, message: 'Código enviado para seu WhatsApp!' });
    } catch (err) {
        console.error('Erro ao enviar código de recuperação:', err);
        res.status(500).json({ success: false, message: 'Erro ao enviar código' });
    }
});

// Recuperar senha - validar código (não marca como usado, apenas verifica)
app.post('/api/auth/cliente/recuperar-validar-codigo', async (req, res) => {
    try {
        const { telefone, codigo } = req.body;
        if (!telefone || !codigo) return res.status(400).json({ success: false, message: 'Telefone e código são obrigatórios' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const codigoLimpo = String(codigo).replace(/\D/g, '');

        const result = await pool.query(
            `SELECT * FROM codigos_verificacao
             WHERE telefone = $1 AND codigo = $2 AND usado = false AND expira_em > NOW()
             ORDER BY id DESC LIMIT 1`,
            [telefoneLimpo, codigoLimpo]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Código inválido ou expirado' });
        }
        res.json({ success: true, message: 'Código validado!' });
    } catch (err) {
        console.error('Erro ao validar código de recuperação:', err);
        res.status(500).json({ success: false, message: 'Erro ao validar código' });
    }
});

// Recuperar senha - validar código + redefinir senha
app.post('/api/auth/cliente/recuperar-redefinir', async (req, res) => {
    try {
        const { telefone, codigo, nova_senha } = req.body;
        if (!telefone || !codigo || !nova_senha) {
            return res.status(400).json({ success: false, message: 'Telefone, código e nova senha são obrigatórios' });
        }
        if (nova_senha.length < 4) {
            return res.status(400).json({ success: false, message: 'A senha deve ter no mínimo 4 dígitos' });
        }
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const codigoLimpo = String(codigo).replace(/\D/g, '');

        const result = await pool.query(
            `SELECT * FROM codigos_verificacao
             WHERE telefone = $1 AND codigo = $2 AND usado = false AND expira_em > NOW()
             ORDER BY id DESC LIMIT 1`,
            [telefoneLimpo, codigoLimpo]
        );
        if (result.rows.length === 0) {
            return res.status(400).json({ success: false, message: 'Código inválido ou expirado' });
        }

        const senhaHash = await bcrypt.hash(nova_senha, 10);
        await pool.query('UPDATE clientes SET senha_hash = $1 WHERE telefone = $2', [senhaHash, telefoneLimpo]);
        await pool.query('UPDATE codigos_verificacao SET usado = true WHERE id = $1', [result.rows[0].id]);

        res.json({ success: true, message: 'Senha redefinida com sucesso! Faça login.' });
    } catch (err) {
        console.error('Erro ao redefinir senha:', err);
        res.status(500).json({ success: false, message: 'Erro ao redefinir senha' });
    }
});
function authClienteMiddleware(req, res, next) {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ success: false, message: 'Token não fornecido' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        if (decoded.tipo !== 'cliente') throw new Error('Token inválido');
        req.cliente = decoded;
        next();
    } catch (err) {
        return res.status(401).json({ success: false, message: 'Token inválido ou expirado' });
    }
}

app.get('/api/meus-pedidos', authClienteMiddleware, async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT * FROM s_pedidos WHERE cliente_id = $1 ORDER BY data_criacao DESC',
            [req.cliente.id]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar pedidos' });
    }
});
// ==================== CONSULTA DE PEDIDOS PELO CLIENTE ====================
// Lista pedidos por telefone (público - cliente verifica pelo próprio número)
app.post('/api/pedidos/consulta', async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) return res.status(400).json({ success: false, message: 'Telefone obrigatório' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });
        const result = await pool.query(
            'SELECT id, nome_cliente, telefone, items, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, data_entrega, hora_entrega, status, data_criacao FROM s_pedidos WHERE telefone = $1 ORDER BY data_criacao DESC',
            [telefoneLimpo]
        );
        res.json({ success: true, data: result.rows });
    } catch (err) {
        console.error('Erro ao consultar pedidos:', err);
        res.status(500).json({ success: false, message: 'Erro ao consultar pedidos' });
    }
});
// Detalhe de um pedido por telefone (público)
app.post('/api/pedidos/consulta/:id', async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) return res.status(400).json({ success: false, message: 'Telefone obrigatório' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const pedido = result.rows[0];
        // Verifica que o telefone informado pertence ao pedido
        if (String(pedido.telefone).replace(/\D/g, '') !== telefoneLimpo) {
            return res.status(403).json({ success: false, message: 'Telefone não corresponde a este pedido' });
        }
        const historico = await pool.query('SELECT * FROM status_historico WHERE pedido_id = $1 ORDER BY created_at DESC', [req.params.id]);
        const itens = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY id', [req.params.id]);
        res.json({ success: true, data: pedido, historico: historico.rows, itens: itens.rows });
    } catch (err) {
        console.error('Erro ao buscar detalhe do pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar detalhe do pedido' });
    }
});
// Página de consulta de pedidos do cliente
app.get('/meus-pedidos.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'meus-pedidos.html'));
});
app.get('/login.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.get('/cadastro.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'cadastro.html'));
});
app.get('/recuperar.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'recuperar.html'));
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

// app.get('/api/pedidos/:id', authMiddleware, async (req, res) => {
//     try {
//         const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
//         if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
//         const historico = await pool.query('SELECT sh.*, u.nome AS usuario_nome FROM status_historico sh LEFT JOIN usuarios u ON u.id = sh.usuario_id WHERE sh.pedido_id = $1 ORDER BY sh.created_at DESC', [req.params.id]);
//         const itens = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY id', [req.params.id]);
//         res.json({ success: true, data: result.rows[0], historico: historico.rows, itens: itens.rows });
//     } catch (err) {
//         res.status(500).json({ success: false, message: 'Erro ao buscar pedido' });
//     }
// });

app.get('/api/pedidos/:id', authMiddleware, async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const historico = await pool.query('SELECT sh.*, u.nome AS usuario_nome FROM status_historico sh LEFT JOIN usuarios u ON u.id = sh.usuario_id WHERE sh.pedido_id = $1 ORDER BY sh.created_at DESC', [req.params.id]);
        const itens = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY id', [req.params.id]);
        res.json({ success: true, data: result.rows[0], historico: historico.rows, itens: itens.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar pedido' });
    }
});

app.put('/api/pedidos/:id/status', authMiddleware, async (req, res) => {
    try {
        const { status, observacao } = req.body;
        const validos = ['Aguardando Confirmacao', 'Pendente', 'Em Producao', 'Em Andamento', 'Entregue', 'Cancelado'];
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
        const { product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras, regras_quantidades } = req.body;
        const rq = typeof regras_quantidades === 'object' && regras_quantidades !== null
            ? JSON.stringify(regras_quantidades)
            : (regras_quantidades || null);
        const result = await pool.query(
            'INSERT INTO s_product_prices (product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras, regras_quantidades) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
            [product_id, price_type, quantity, unit_label, label, price, opcoes || '', composicao || '', regras || '', rq]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao criar preço' });
    }
});

app.put('/api/precos/:id', authMiddleware, async (req, res) => {
    try {
        const { price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, regras_quantidades } = req.body;
        const rq = typeof regras_quantidades === 'object' && regras_quantidades !== null
            ? JSON.stringify(regras_quantidades)
            : (regras_quantidades || null);
        const result = await pool.query(
            'UPDATE s_product_prices SET price_type=$1, quantity=$2, unit_label=$3, label=$4, price=$5, is_active=$6, opcoes=$7, composicao=$8, regras=$9, regras_quantidades=$10 WHERE id=$11 RETURNING *',
            [price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, rq, req.params.id]
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

// ==================== PÁGINAS ====================
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/confirmar.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'confirmar.html'));
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