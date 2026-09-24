export default {
  fetch(): Response {
    return new Response(
      "Mentis cloud entry point scaffold only; MCP and OAuth are not implemented.",
      { status: 501 },
    );
  },
};
