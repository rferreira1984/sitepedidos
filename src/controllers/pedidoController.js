const db = require("../config/database");
module.exports = {
  listarPedidos: async (req, res) => {
    try {
      const { search, status, page=1, limit=20 } = req.query;
      const offset = (page-1)*limit; let v=[], c=[];
      if (search) { v.push("%"+search+"%"); c.push("(nome_cliente ILIKE $"+v.length+" OR id::text ILIKE $"+v.length+" OR items ILIKE $"+v.length+")"); }
      if (status) { v.push(status); c.push("status = $"+v.length); }
      const w = c.length ? "WHERE "+c.join(" AND ") : "";
      const [r,tr,sr] = await Promise.all([
        db.query("SELECT * FROM s_pedidos "+w+" ORDER BY data_criacao DESC LIMIT $"+(v.length+1)+" OFFSET $"+(v.length+2), [...v,limit,offset]),
        db.query("SELECT COUNT(*) FROM s_pedidos "+w, v),
        db.query("SELECT COUNT(*) as t, COUNT(*) FILTER (WHERE status='Pendente') as p, COUNT(*) FILTER (WHERE status='Em Andamento') as e, COUNT(*) FILTER (WHERE status='Entregue') as en FROM s_pedidos")
      ]);
      const total = parseInt(tr.rows[0].count);
      res.json({ success:true, data:r.rows, stats:sr.rows[0], pagination:{total,page:parseInt(page),totalPages:Math.ceil(total/limit),limit:parseInt(limit)} });
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  },
  obterPedido: async (req, res) => {
    try {
      const r = await db.query("SELECT * FROM s_pedidos WHERE id=$1", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({success:false});
      res.json({success:true,data:r.rows[0]});
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  },
  criarPedido: async (req, res) => {
    try {
      const b = req.body;
      if (!b.nome_cliente||!b.items||!b.valor_total) return res.status(400).json({success:false,message:"Campos obrigatorios"});
      const r = await db.query("INSERT INTO s_pedidos (nome_cliente,items,valor_total,status) VALUES($1,$2,$3,$4) RETURNING *",
        [b.nome_cliente,b.items,b.valor_total,b.status||"Pendente"]);
      res.status(201).json({success:true,data:r.rows[0]});
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  },
  atualizarPedido: async (req, res) => {
    try {
      const fields = req.body;
      if (!Object.keys(fields).length) return res.status(400).json({success:false});
      const set = Object.keys(fields).map((k,i)=>k+"=$"+(i+1)).join(",");
      const v = Object.values(fields); v.push(req.params.id);
      const r = await db.query("UPDATE s_pedidos SET "+set+" WHERE id=$"+v.length+" RETURNING *", v);
      if (!r.rows.length) return res.status(404).json({success:false});
      res.json({success:true,data:r.rows[0]});
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  },
  excluirPedido: async (req, res) => {
    try {
      const r = await db.query("DELETE FROM s_pedidos WHERE id=$1 RETURNING id", [req.params.id]);
      if (!r.rows.length) return res.status(404).json({success:false});
      res.json({success:true});
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  },
  obterStats: async (req, res) => {
    try {
      const r = await db.query("SELECT COUNT(*) as t, COUNT(*) FILTER (WHERE status='Pendente') as p, COUNT(*) FILTER (WHERE status='Em Andamento') as e, COUNT(*) FILTER (WHERE status='Entregue') as en, SUM(valor_total) as s, AVG(valor_total) as m FROM s_pedidos");
      const d = r.rows[0];
      res.json({success:true,data:{total:parseInt(d.t)||0,pendentes:parseInt(d.p)||0,em_andamento:parseInt(d.e)||0,entregues:parseInt(d.en)||0,valor_total_sum:parseFloat(d.s)||0,ticket_medio:parseFloat(d.m)||0}});
    } catch(e) { res.status(500).json({success:false,message:e.message}); }
  }
};