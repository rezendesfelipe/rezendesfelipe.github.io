<%*
const lang = await tp.system.suggester(["Português", "English"], ["pt", "en"]);
const folder = lang === "pt" ? "pt-br" : "en-us";
const title = await tp.system.prompt("Título do post");
const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
const date = tp.date.now("YYYY-MM-DD");
await tp.file.move(`blog/${folder}/${date}/${slug}`);
-%>
---
title: "<% title %>"
description: ""
pubDate: <% date %>
lang: "<% lang %>"
tags: []
category: ""
draft: true 

---

## Introdução

## Desenvolvimento

## Conclusão