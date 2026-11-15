import { Elysia } from "elysia"; new Elysia().get("/", () => "ok").listen(3000);
