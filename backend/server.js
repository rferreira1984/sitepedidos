require("dotenv").config({ path: require("path").resolve(__dirname, "..", ".env") });
const express = require("express");
const cors = require("cors");
const routes = require("./src/routes/pedidos");
const { testConnection } = require("./src/config/database");
const app = express();
const PORT = process.env.PORT || 3001;
app.use(cors());
app.use(express.json());
app.use("/api/pedidos", routes);
app.use((req,res) => res.status(404).json({erro:"Rota nao encontrada"}));
app.use((err,req,res,next) => { console.error(err); res.status(500).json({success:false}); });
async function start() {
  const ok = await testConnection();
  if (ok) { app.listen(PORT, () => console.log("Servidor na porta "+PORT)); }
  else { console.error("Falha no banco"); process.exit(1); }
}
start();
module.exports = app;