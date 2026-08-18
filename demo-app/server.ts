import { createApp } from "./app";

const port = Number(process.env.PORT ?? 3100);
const host = "127.0.0.1";

const app = createApp();
app.listen(port, host, () => {
  console.log(`CoreBank Lite listening on http://${host}:${port}`);
});
