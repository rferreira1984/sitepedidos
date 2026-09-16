require('dotenv').config();
const fs = require('fs');
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
app.use(express.json({ limit: '10mb' }));
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
// ===== REGRAS DE HORÁRIOS (backend) =====
const REGRAS_HORARIOS = {
    pedidoMesmoDiaLimite: '16:00',
    antecedenciaKitMin: 2,
    antecedenciaItensMin: 1,
    retirada: {
        segSexta: { inicio: '07:00', fim: '19:00' },
        sabado: { inicio: '07:00', fim: '19:00' },
        domingoFeriado: { inicio: '08:30', fim: '14:30' }
    },
    entrega: {
        segSexta: { inicio: '08:30', fim: '18:00' },
        sabado: { inicio: '08:30', fim: '16:00' },
        domingoFeriado: { inicio: '08:30', fim: '14:30' }
    }
};
const FERIADOS_FIXOS = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25'];
function ehFeriado(dataStr) {
    const mmdd = String(dataStr).substring(5, 10);
    return FERIADOS_FIXOS.includes(mmdd);
}
function diaSemana(dataStr) {
    const d = new Date(String(dataStr) + 'T12:00:00');
    return d.getDay();
}
function janelaHorario(tipoLogistica, dataStr) {
    const dia = diaSemana(dataStr);
    const feriado = ehFeriado(dataStr);
    const regras = tipoLogistica === 'Retirada' ? REGRAS_HORARIOS.retirada : REGRAS_HORARIOS.entrega;
    if (feriado || dia === 0) return regras.domingoFeriado;
    if (dia === 6) return regras.sabado;
    return regras.segSexta;
}
function validarRegrasPedido(dataEntrega, horaEntrega, tipoLogistica, itens) {
    if (!dataEntrega || !horaEntrega) {
        return { ok: false, msg: 'Data e horário são obrigatórios' };
    }
    const agora = new Date();
    const hojeStr = agora.toISOString().substring(0, 10);
    const dataPedido = new Date(dataEntrega + 'T' + horaEntrega + ':00');
    const dia = diaSemana(dataEntrega);
    const feriado = ehFeriado(dataEntrega);
    if (dataPedido < agora) {
        return { ok: false, msg: 'A data/horário escolhida já passou.' };
    }
    // Sábado/domingo/feriado: pedido deve ser confirmado até sexta
    if (dia === 0 || dia === 6 || feriado) {
        if (dataEntrega === hojeStr) {
            return { ok: false, msg: 'Pedidos para sábado/domingo/feriado precisam ser confirmados até sexta-feira. Entre em contato para verificar disponibilidade.' };
        }
    }
    // Mesmo dia: limite 16h + antecedência
    if (dataEntrega === hojeStr) {
        const horaAtualMin = agora.getHours() * 60 + agora.getMinutes();
        if (horaAtualMin > 16 * 60) {
            return { ok: false, msg: 'Pedidos para hoje devem ser feitos até às 16h00.' };
        }
        const temKit = Array.isArray(itens) && itens.some(i => String(i.nome || '').toLowerCase().includes('kit'));
        const minAntecedencia = temKit ? REGRAS_HORARIOS.antecedenciaKitMin * 60 : REGRAS_HORARIOS.antecedenciaItensMin * 60;
        const [hh, mm] = String(horaEntrega).split(':').map(Number);
        const horaPedidoMin = hh * 60 + mm;
        if (horaPedidoMin - horaAtualMin < minAntecedencia) {
            const tipo = temKit ? 'Kit Festa (2h)' : 'itens (1h)';
            return { ok: false, msg: 'Para pedidos no mesmo dia, o ' + tipo + ' exige antecedência mínima.' };
        }
    }
    // Janela de retirada/entrega
    const janela = janelaHorario(tipoLogistica, dataEntrega);
    const [hIni, mIni] = janela.inicio.split(':').map(Number);
    const [hFim, mFim] = janela.fim.split(':').map(Number);
    const [hh, mm] = String(horaEntrega).split(':').map(Number);
    const horaMin = hh * 60 + mm;
    const iniMin = hIni * 60 + mIni;
    const fimMin = hFim * 60 + mFim;
    if (horaMin < iniMin || horaMin > fimMin) {
        const tipo = tipoLogistica === 'Retirada' ? 'retirada' : 'entrega';
        return { ok: false, msg: 'Horário de ' + tipo + ' fora da janela permitida (' + janela.inicio + ' às ' + janela.fim + ').' };
    }
    return { ok: true };
}
// ===== PASTA DE UPLOADS (imagens de decoração) =====
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });
// ===== UPLOAD DE IMAGEM (decoração do kit) =====
app.post('/api/upload', async (req, res) => {
    try {
        const { base64, filename } = req.body;
        if (!base64) return res.status(400).json({ success: false, message: 'Imagem obrigatória' });
        const data = base64.replace(/^data:image\/\w+;base64,/, '');
        const ext = (filename && filename.includes('.')) ? filename.split('.').pop().toLowerCase() : 'png';
        const safeExt = ['png', 'jpg', 'jpeg', 'gif', 'webp'].includes(ext) ? ext : 'png';
        const name = 'decoracao_' + Date.now() + '_' + Math.random().toString(36).substring(2, 8) + '.' + safeExt;
        fs.writeFileSync(path.join(UPLOAD_DIR, name), Buffer.from(data, 'base64'));
        res.json({ success: true, url: '/uploads/' + name });
    } catch (err) {
        console.error('Erro ao salvar imagem:', err);
        res.status(500).json({ success: false, message: 'Erro ao salvar imagem' });
    }
});
// ==================== SABORES POR TIPO DE CENTO (com id) ====================
app.get('/api/sabores-cento', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT c.name AS categoria, p.id AS product_id, p.name AS sabor
             FROM s_products p
             JOIN s_categories c ON c.id = p.category_id
             WHERE p.is_active = true
               AND (c.name ILIKE '%salgado%' OR c.name ILIKE '%doce%')
             ORDER BY c.display_order, p.name`
        );
        const grupos = {};
        result.rows.forEach(r => {
            if (!grupos[r.categoria]) grupos[r.categoria] = [];
            // devolve { id, name } para registrar a composição no banco
            grupos[r.categoria].push({ id: parseInt(r.product_id), name: r.sabor });
        });
        res.json({ success: true, data: grupos });
    } catch (err) {
        console.error('Erro ao buscar sabores de cento:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar sabores de cento' });
    }
});
// ==================== SABORES PARA CENTO DE SALGADOS ====================
app.get('/api/sabores-salgados', async (req, res) => {
    try {
        const result = await pool.query(
            `SELECT DISTINCT p.name FROM s_products p
             JOIN s_categories c ON c.id = p.category_id
             WHERE p.is_active = true
               AND (c.slug IN ('salgados-fritos', 'salgados-assados')
                    OR c.name ILIKE '%salgado%')
             ORDER BY p.name`
        );
        res.json({ success: true, data: result.rows.map(r => r.name) });
    } catch (err) {
        console.error('Erro ao buscar sabores:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar sabores' });
    }
});
// ==================== SABORES PARA KITS (com id, preço/kg e bolo_kit) ====================
app.get('/api/sabores', async (req, res) => {
    try {
        async function buscarProdutosComPreco(catFiltro) {
            const cats = await pool.query(
                'SELECT id, name FROM s_categories WHERE ' + catFiltro + ' ORDER BY display_order'
            );
            if (cats.rows.length === 0) return [];
            const out = [];
            for (const c of cats.rows) {
                const prods = await pool.query(
                    'SELECT id, name FROM s_products WHERE category_id = $1 AND is_active = true ORDER BY name',
                    [c.id]
                );
                for (const p of prods.rows) {
                    const prices = await pool.query(
                        'SELECT price FROM s_product_prices WHERE product_id = $1 AND is_active = true',
                        [p.id]
                    );
                    if (prices.rows.length === 0) continue;
                    const maxPrice = Math.max(...prices.rows.map(r => parseFloat(r.price)));
                    // id incluído para permitir registrar a composição do kit
                    out.push({ id: p.id, name: p.name, price: maxPrice });
                }
            }
            return out;
        }
        const bolosRes = await pool.query(
            `SELECT DISTINCT p.id, p.name
             FROM s_products p
             JOIN s_categories c ON c.id = p.category_id
             JOIN s_product_prices sp ON sp.product_id = p.id AND sp.is_active = true AND sp.bolo_kit = true
             WHERE p.is_active = true
               AND c.name ILIKE '%bolo%' AND c.name NOT ILIKE '%kit%'
             ORDER BY p.name`
        );
        const bolos = [];
        for (const b of bolosRes.rows) {
            const prices = await pool.query(
                'SELECT price FROM s_product_prices WHERE product_id = $1 AND is_active = true AND bolo_kit = true',
                [b.id]
            );
            if (prices.rows.length === 0) continue;
            const maxPrice = Math.max(...prices.rows.map(r => parseFloat(r.price)));
            bolos.push({ id: b.id, name: b.name, price: maxPrice });
        }
        let salgados = await buscarProdutosComPreco(`name ILIKE '%salgado%' AND name ILIKE '%frito%'`);
        if (salgados.length === 0) salgados = await buscarProdutosComPreco(`name ILIKE '%salgado%'`);
        let doces = await buscarProdutosComPreco(`name ILIKE '%doce%' AND name ILIKE '%tradicional%'`);
        if (doces.length === 0) doces = await buscarProdutosComPreco(`name ILIKE '%doce%' AND name NOT ILIKE '%gourmet%'`);
        if (doces.length === 0) doces = await buscarProdutosComPreco(`name ILIKE '%doce%'`);
        // Refrigerantes com id real (antes eram fixos no front-end)
        let refrigerantes = await buscarProdutosComPreco(`name ILIKE '%refrigerante%' OR name ILIKE '%refri%' OR name ILIKE '%bebida%'`);
        res.json({ success: true, data: { bolos, doces, salgados, refrigerantes } });
    } catch (err) {
        console.error('Erro ao buscar sabores:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar sabores' });
    }
});
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
                'SELECT id, price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, regras_quantidades, bolo_kit FROM s_product_prices WHERE product_id = $1 AND is_active = true ORDER BY price_type, quantity',
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
// POST /api/pedidos - Cliente cria pedido (com validação de horários)
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
        // VALIDAÇÃO DAS REGRAS DE HORÁRIO
        const validacao = validarRegrasPedido(dataEntrega, horaEntrega, tipo_logistica || 'Entrega', itens);
        if (!validacao.ok) {
            return res.status(400).json({ success: false, message: validacao.msg });
        }
        // TODO PEDIDO INICIA COMO PENDENTE (conforme fluxo)
        const statusInicial = 'Pendente';
        const result = await pool.query(
            `INSERT INTO s_pedidos (nome_cliente, telefone, endereco_rua, endereco_numero, endereco_bairro, endereco_cep, items, valor_total, taxa_entrega, forma_pagamento, tipo_logistica, observacoes, data_entrega, hora_entrega, cliente_id, status, sistema)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,'1') RETURNING *`,
            [nome_cliente, telefone, endereco_rua || '', endereco_numero || '', endereco_bairro || '', endereco_cep || '', items, valor_total, taxa_entrega || 0, forma_pagamento || '', tipo_logistica || '', observacoes || '', dataEntrega, horaEntrega, cliente_id || null, statusInicial]
        );
        const pedido = result.rows[0];
        if (Array.isArray(itens) && itens.length > 0) {
            // for (const item of itens) {
            //     // Quantidade: aceita decimal (venda por quilo) em vez de forçar inteiro
            //     const qtdBruta = parseFloat(item.quantidade);
            //     const quantidade = (isNaN(qtdBruta) || qtdBruta <= 0) ? 1 : qtdBruta;
            //     // NOVO: quantidade em quilos (ex.: bolo por kg de 2,5 kg => quantidade = 1, quantidade_kg = 2.5)
            //     const kgBruto = parseFloat(item.quantidade_kg);
            //     const quantidadeKg = (isNaN(kgBruto) || kgBruto <= 0) ? null : kgBruto;
            //     const itemRes = await pool.query(
            //         `INSERT INTO pedido_itens (pedido_id, product_id, product_name, label, quantidade, quantidade_kg, preco_unitario, preco_total, descricao)
            //          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            //         [
            //             pedido.id,
            //             item.product_id || null,
            //             item.nome || '',
            //             item.label || '',
            //             quantidade,
            //             quantidadeKg,
            //             parseFloat(item.preco_unitario) || 0,
            //             parseFloat(item.preco_total) || 0,
            //             item.descricao || null
            //         ]
            //     );
            // }
         for (const item of itens) {
        // Quantidade do ITEM (unidades). Na venda por quilo: quantidade = 1
        // e o peso vai para a coluna quantidade_kg.
        const qtdBruta = parseFloat(item.quantidade);
        const quantidade = (item.porQuilo) ? 1 : ((isNaN(qtdBruta) || qtdBruta <= 0) ? 1 : qtdBruta);
        const kgBruto = parseFloat(item.quantidade_kg);
        const quantidade_kg = (item.porQuilo || item.quantidade_kg != null) && !isNaN(kgBruto) && kgBruto > 0
            ? kgBruto
            : null;
        const itemRes = await pool.query(
            `INSERT INTO pedido_itens (pedido_id, product_id, product_name, label, quantidade, quantidade_kg, preco_unitario, preco_total, descricao)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
            [
                pedido.id,
                item.product_id || null,
                item.nome || '',
                item.label || '',
                quantidade,
                quantidade_kg,
                parseFloat(item.preco_unitario) || 0,
                parseFloat(item.preco_total) || 0,
                item.descricao || null
            ]
        );
                const pedidoItemId = itemRes.rows[0].id;
                // ===== COMPOSIÇÃO (kits e centos): grava cada item escolhido com id e quantidade =====
                const composicao = Array.isArray(item.composicao_itens) ? item.composicao_itens : [];
                if (composicao.length > 0) {
                    try {
                        for (const comp of composicao) {
                            if (!comp || !comp.nome) continue;
                            const qc = parseFloat(comp.quantidade);
                            await pool.query(
                                `INSERT INTO pedido_item_composicao
                                     (pedido_item_id, pedido_id, product_id, product_name, grupo, quantidade, observacao)
                                 VALUES ($1,$2,$3,$4,$5,$6,$7)`,
                                [
                                    pedidoItemId,
                                    pedido.id,
                                    comp.product_id || null,
                                    comp.nome,
                                    comp.grupo || null,
                                    (isNaN(qc) || qc <= 0) ? 1 : qc,
                                    comp.observacao || null
                                ]
                            );
                        }
                    } catch (errComp) {
                        console.error('ATENÇÃO: erro ao gravar composição do item. A migração migracao_composicao.sql foi executada?', errComp.message);
                    }
                }
            }
        
        if (confirmar_whatsapp) {
            const token = crypto.randomBytes(32).toString('hex');
            const expiraEm = new Date(Date.now() + 30 * 60 * 1000);
            await pool.query(
                'INSERT INTO tokens_confirmacao (pedido_id, telefone, token, expira_em) VALUES ($1,$2,$3,$4)',
                [pedido.id, telefone, token, expiraEm]
            );
            const link = `${SITE_URL}/confirmar.html?token=${token}`;
            await enviarWebhookConfirmacao(link, telefone, nome_cliente);
            return res.status(201).json({ success: true, data: pedido, link_confirmacao: link, message: 'Pedido criado! Confirme pelo link.' });
        }
        res.status(201).json({ success: true, data: pedido, message: 'Pedido criado com sucesso!' });
    }
    } catch (err) {
        console.error('Erro ao criar pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao criar pedido' });
    }
});
// Calcular custo de entrega
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
// Confirmar pedido pelo link
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
        if (token.confirmado) {
            return res.json({ success: true, message: 'Este pedido já foi confirmado anteriormente!', pedido_id: token.pedido_id });
        }
        if (new Date(token.expira_em) < new Date()) {
            return res.status(400).json({ success: false, message: 'Link expirado. Faça um novo pedido ou solicite outro link.' });
        }
        await pool.query('UPDATE tokens_confirmacao SET confirmado = true WHERE id = $1', [token.id]);
        await pool.query('UPDATE s_pedidos SET status = $1 WHERE id = $2', ['Pendente', token.pedido_id]);
        await pool.query(
            'INSERT INTO status_historico (pedido_id, status_anterior, status_novo, observacao) VALUES ($1,$2,$3,$4)',
            [token.pedido_id, token.status || 'Pendente', 'Pendente', 'Confirmado pelo link']
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
                telefone: telefone,
                nome: nome,
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
async function enviarWebhookVerificacaoSMS(numero, codigo) {
    try {
        const res = await fetch(WEBHOOK_CONFIRMACAO, {
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
// ==================== AUTENTICAÇÃO DO CLIENTE ====================
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
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });
        const codigo = String(Math.floor(1000 + Math.random() * 9000));
        await pool.query('UPDATE codigos_verificacao SET usado = true WHERE telefone = $1', [telefoneLimpo]);
        await pool.query(`INSERT INTO codigos_verificacao (telefone, codigo, expira_em)
                        VALUES ($1, $2, NOW() + INTERVAL '10 minutes')`,
                        [telefoneLimpo, codigo]);
        await enviarWebhookVerificacao(telefoneLimpo, codigo); // aqui envia whats
        res.json({ success: true, message: 'Código enviado para seu WhatsApp!' });
        //await enviarWebhookVerificacaoSMS(telefoneLimpo, codigo)
       // res.json({ success: true, message: 'Código enviado por SMS para '+telefoneLimpo});
    } catch (err) {
        console.error('Erro ao enviar código:', err);
        res.status(500).json({ success: false, message: 'Erro ao enviar código' });
    }
});
app.post('/api/auth/cliente/validar-codigo', async (req, res) => {
    try {
        const { telefone, codigo } = req.body;
        if (!telefone || !codigo) return res.status(400).json({ success: false, message: 'Telefone e código são obrigatórios' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const codigoLimpo = String(codigo).replace(/\D/g, '');
        if (telefoneLimpo.length < 10) return res.status(400).json({ success: false, message: 'Telefone inválido' });
        if (codigoLimpo.length !== 4) return res.status(400).json({ success: false, message: 'Código deve ter 4 dígitos' });
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
app.post('/api/pedidos/consulta/:id', async (req, res) => {
    try {
        const { telefone } = req.body;
        if (!telefone) return res.status(400).json({ success: false, message: 'Telefone obrigatório' });
        const telefoneLimpo = String(telefone).replace(/\D/g, '');
        const result = await pool.query('SELECT * FROM s_pedidos WHERE id = $1', [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ success: false, message: 'Pedido não encontrado' });
        const pedido = result.rows[0];
        if (String(pedido.telefone).replace(/\D/g, '') !== telefoneLimpo) {
            return res.status(403).json({ success: false, message: 'Telefone não corresponde a este pedido' });
        }
        const historico = await pool.query('SELECT * FROM status_historico WHERE pedido_id = $1 ORDER BY created_at DESC', [req.params.id]);
        const itens = await pool.query('SELECT * FROM pedido_itens WHERE pedido_id = $1 ORDER BY id', [req.params.id]);
        // Composição dos kits e centos (itens escolhidos com id e quantidade, sem preço)
        const composicao = await pool.query(
            'SELECT * FROM pedido_item_composicao WHERE pedido_id = $1 ORDER BY pedido_item_id, id',
            [req.params.id]
        );
        const itensComComposicao = itens.rows.map(i => ({
            ...i,
            composicao: composicao.rows.filter(c => String(c.pedido_item_id) === String(i.id))
        }));
        res.json({ success: true, data: pedido, historico: historico.rows, itens: itensComComposicao, composicao: composicao.rows });
    } catch (err) {
        console.error('Erro ao buscar detalhe do pedido:', err);
        res.status(500).json({ success: false, message: 'Erro ao buscar detalhe do pedido' });
    }
});
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
        const stats = await pool.query(`SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='Pendente')::int AS pendentes,
            COUNT(*) FILTER (WHERE status='Aguardando Pagamento')::int AS aguardando_pagamento,
            COUNT(*) FILTER (WHERE status='Em Producao')::int AS em_producao,
            COUNT(*) FILTER (WHERE status='Pedido Pronto')::int AS pedido_pronto,
            COUNT(*) FILTER (WHERE status='Aguardando Retirada')::int AS aguardando_retirada,
            COUNT(*) FILTER (WHERE status='Saiu Para Entrega')::int AS saiu_para_entrega,
            COUNT(*) FILTER (WHERE status='Entregue')::int AS entregues,
            COUNT(*) FILTER (WHERE status='Finalizado')::int AS finalizados,
            COUNT(*) FILTER (WHERE status='Cancelado')::int AS cancelados FROM s_pedidos`);
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
        // Itens com categoria e local de produção
        const itens = await pool.query(
            `SELECT pi.*, c.name AS categoria, c.local_producao AS local_producao
             FROM pedido_itens pi
             LEFT JOIN s_products p ON p.id = pi.product_id
             LEFT JOIN s_categories c ON c.id = p.category_id
             WHERE pi.pedido_id = $1 ORDER BY pi.id`,
            [req.params.id]
        );
        // Composição dos kits e centos (itens escolhidos com id e quantidade, sem preço)
        const composicao = await pool.query(
            `SELECT pic.*, c.name AS categoria_produto, c.local_producao AS local_producao
             FROM pedido_item_composicao pic
             LEFT JOIN s_products p ON p.id = pic.product_id
             LEFT JOIN s_categories c ON c.id = p.category_id
             WHERE pic.pedido_id = $1
             ORDER BY pic.pedido_item_id, pic.id`,
            [req.params.id]
        );
        const itensComComposicao = itens.rows.map(i => ({
            ...i,
            composicao: composicao.rows.filter(c => String(c.pedido_item_id) === String(i.id))
        }));
        res.json({ success: true, data: result.rows[0], historico: historico.rows, itens: itensComComposicao, composicao: composicao.rows });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao buscar pedido' });
    }
});
app.put('/api/pedidos/:id/status', authMiddleware, async (req, res) => {
    try {
        const { status, observacao } = req.body;
        const validos = ['Pendente', 'Aguardando Pagamento', 'Confirmado', 'Em Producao', 'Pedido Pronto', 'Aguardando Retirada', 'Saiu Para Entrega', 'Entregue', 'Finalizado', 'Cancelado'];
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
        const result = await pool.query(`SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status='Pendente')::int AS pendentes,
            COUNT(*) FILTER (WHERE status='Aguardando Pagamento')::int AS aguardando_pagamento,
            COUNT(*) FILTER (WHERE status='Em Producao')::int AS em_producao,
            COUNT(*) FILTER (WHERE status='Pedido Pronto')::int AS pedido_pronto,
            COUNT(*) FILTER (WHERE status='Aguardando Retirada')::int AS aguardando_retirada,
            COUNT(*) FILTER (WHERE status='Saiu Para Entrega')::int AS saiu_para_entrega,
            COUNT(*) FILTER (WHERE status='Entregue')::int AS entregues,
            COUNT(*) FILTER (WHERE status='Finalizado')::int AS finalizados,
            COUNT(*) FILTER (WHERE status='Cancelado')::int AS cancelados,
            COALESCE(SUM(valor_total) FILTER (WHERE status!='Cancelado'),0)::numeric(10,2) AS faturamento_total,
            COALESCE(SUM(valor_total) FILTER (WHERE status='Entregue'),0)::numeric(10,2) AS faturamento_entregue FROM s_pedidos`);
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
// CRUD Preços (admin) — inclui bolo_kit
app.post('/api/precos', authMiddleware, async (req, res) => {
    try {
        const { product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras, regras_quantidades, bolo_kit } = req.body;
        const rq = typeof regras_quantidades === 'object' && regras_quantidades !== null
            ? JSON.stringify(regras_quantidades)
            : (regras_quantidades || null);
        const result = await pool.query(
            'INSERT INTO s_product_prices (product_id, price_type, quantity, unit_label, label, price, opcoes, composicao, regras, regras_quantidades, bolo_kit) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
            [product_id, price_type, quantity, unit_label, label, price, opcoes || '', composicao || '', regras || '', rq, bolo_kit === true]
        );
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        res.status(500).json({ success: false, message: 'Erro ao criar preço' });
    }
});
app.put('/api/precos/:id', authMiddleware, async (req, res) => {
    try {
        const { price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, regras_quantidades, bolo_kit } = req.body;
        const rq = typeof regras_quantidades === 'object' && regras_quantidades !== null
            ? JSON.stringify(regras_quantidades)
            : (regras_quantidades || null);
        const result = await pool.query(
            'UPDATE s_product_prices SET price_type=$1, quantity=$2, unit_label=$3, label=$4, price=$5, is_active=$6, opcoes=$7, composicao=$8, regras=$9, regras_quantidades=$10, bolo_kit=$11 WHERE id=$12 RETURNING *',
            [price_type, quantity, unit_label, label, price, is_active, opcoes, composicao, regras, rq, bolo_kit === true, req.params.id]
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