const axios = require("axios");

async function run() {
  const apiUrl = process.env.FOOTBALLBRAIN_API_URL;

  if (!apiUrl) {
    throw new Error(
      "FOOTBALLBRAIN_API_URL manquante"
    );
  }

  const secret = process.env.INTERNAL_CRON_SECRET;

  if (!secret) {
    throw new Error(
      "INTERNAL_CRON_SECRET manquant"
    );
  }

  const response = await axios.get(
    `${apiUrl}/internal/cron/update-results`,
    {
      params: {
        secret,
        limit: 20,
      },
      timeout: 120000,
    }
  );

  console.log(
    JSON.stringify(response.data, null, 2)
  );
}

run()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error(
      error.response?.data ||
      error.message
    );

    process.exit(1);
  });