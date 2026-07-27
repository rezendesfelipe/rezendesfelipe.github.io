<%*
const lang = await tp.system.suggester(["Português", "English"], ["pt", "en"]);
const folder = lang === "pt" ? "pt-br" : "en-us";
const title = await tp.system.prompt("Nome da certificação");
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
await tp.file.move(`certifications/${folder}/${slug}`);
-%>
---
lang: "<% lang %>"
title: "<% title %>"
issuer: ""
issuedAt: <% tp.date.now("YYYY-MM-DD") %>
url: ""
order:

---