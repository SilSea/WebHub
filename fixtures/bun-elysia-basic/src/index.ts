import { Elysia } from "elysia";

new Elysia().group("/api", (app) => app.get("/", () => "ok")).listen(process.env.PORT ?? 3000);
