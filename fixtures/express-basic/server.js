const express = require("express");
const app = express();
app.use("/api", (_req, res) => res.json({ ok: true }));
app.listen(process.env.PORT || 4000);
