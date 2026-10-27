export default async function (ctx) {
  await ctx.evaluate("page", (text) => {
    document.getElementById("title").textContent = text;
  }, "Scripted title");
}
