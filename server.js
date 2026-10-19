const http = require("node:http");
const fs = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const root = __dirname;
const dataDirectory = path.join(root, "data");
const responsesFile = path.join(dataDirectory, "responses.json");
const port = Number(process.env.PORT) || 3000;
const statuses = new Set(["New", "Considering", "Accepted", "Declined"]);
const trashRetentionMs = 7 * 24 * 60 * 60 * 1000;
const contentTypes = {
	".css": "text/css; charset=utf-8",
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".json": "application/json; charset=utf-8",
};

async function readResponses() {
	try {
		const responses = JSON.parse(await fs.readFile(responsesFile, "utf8"));
		const cutoff = Date.now() - trashRetentionMs;
		let changed = false;
		for (const item of responses) {
			if (item.status === "Declined" && !item.deletedAt) {
				item.deletedAt = new Date().toISOString();
				changed = true;
			}
		}
		const remaining = responses.filter((item) => !item.deletedAt || Date.parse(item.deletedAt) > cutoff);
		if (changed || remaining.length !== responses.length) await writeResponses(remaining);
		return remaining;
	} catch (error) {
		if (error.code === "ENOENT") return [];
		throw error;
	}
}

async function writeResponses(responses) {
	await fs.mkdir(dataDirectory, { recursive: true });
	await fs.writeFile(responsesFile, `${JSON.stringify(responses, null, 2)}\n`);
}

function sendJson(response, statusCode, value) {
	response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
	response.end(JSON.stringify(value));
}

async function readBody(request) {
	let body = "";
	for await (const chunk of request) {
		body += chunk;
		if (body.length > 1_000_000) throw new Error("Request body is too large.");
	}
	return body;
}

async function serveFile(request, response, pathname) {
	const requestedPath = pathname === "/" ? "/index.html" : decodeURIComponent(pathname);
	const filePath = path.resolve(root, `.${requestedPath}`);
	if (!filePath.startsWith(`${root}${path.sep}`)) {
		response.writeHead(403);
		response.end("Forbidden");
		return;
	}

	try {
		const contents = await fs.readFile(filePath);
		response.writeHead(200, {
			"Content-Type": contentTypes[path.extname(filePath)] || "application/octet-stream",
		});
		if (request.method === "HEAD") response.end();
		else response.end(contents);
	} catch (error) {
		response.writeHead(error.code === "ENOENT" ? 404 : 500);
		response.end(error.code === "ENOENT" ? "Not found" : "Unable to read file");
	}
}

function checkAuth(request, response) {
	const password = process.env.ADMIN_PASSWORD || "collective123";
	const auth = request.headers.authorization;
	if (!auth || !auth.startsWith("Basic ")) {
		response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Band Dashboard"' });
		response.end("Password required");
		return false;
	}
	const [, pass] = Buffer.from(auth.slice(6), "base64").toString().split(":");
	if (pass !== password) {
		response.writeHead(401, { "WWW-Authenticate": 'Basic realm="Band Dashboard"' });
		response.end("Invalid password");
		return false;
	}
	return true;
}

const server = http.createServer(async (request, response) => {
	try {
		const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);

		// Block public access to the raw JSON file and server code.
		if (url.pathname.startsWith("/data") || url.pathname === "/server.js") {
			response.writeHead(403);
			response.end("Forbidden");
			return;
		}

		// Require a password for the dashboard and API routes.
		if (url.pathname === "/responses.html" || url.pathname.startsWith("/api/requests")) {
			if (!checkAuth(request, response)) return;
		}

		if (request.method === "GET" && url.pathname === "/api/requests") {
			sendJson(response, 200, await readResponses());
			return;
		}

		const statusMatch = url.pathname.match(/^\/api\/requests\/([\w-]+)$/);
		if (request.method === "PATCH" && statusMatch) {
			const updates = JSON.parse(await readBody(request));
			if (!statuses.has(updates.status)) {
				sendJson(response, 400, { error: "Invalid request status." });
				return;
			}
			const responses = await readResponses();
			const item = responses.find((entry) => entry.id === statusMatch[1]);
			if (!item) {
				sendJson(response, 404, { error: "Request not found." });
				return;
			}
			item.status = updates.status;
			if (updates.status === "Declined") item.deletedAt ||= new Date().toISOString();
			else delete item.deletedAt;
			await writeResponses(responses);
			sendJson(response, 200, item);
			return;
		}
		if (request.method === "DELETE" && statusMatch) {
			const responses = await readResponses();
			const item = responses.find((entry) => entry.id === statusMatch[1]);
			if (!item) {
				sendJson(response, 404, { error: "Request not found." });
				return;
			}
			if (!item.deletedAt) {
				sendJson(response, 409, { error: "Only declined requests in the recycling bin can be deleted." });
				return;
			}
			await writeResponses(responses.filter((entry) => entry.id !== item.id));
			sendJson(response, 200, { success: true });
			return;
		}

		if (request.method === "POST" && url.pathname === "/requests") {
			const fields = Object.fromEntries(new URLSearchParams(await readBody(request)));
			const requiredFields = [
				"Contact person", "Organization", "Email", "Event name or occasion",
				"Event date", "Event time", "Event location", "Expected event duration",
				"Requested performance length", "Compensation", "Food or refreshments provided",
			];
			if (requiredFields.some((field) => !fields[field]?.trim())) {
				response.writeHead(400, { "Content-Type": "text/plain; charset=utf-8" });
				response.end("Please complete all required fields.");
				return;
			}

			const responses = await readResponses();
			responses.unshift({
				id: randomUUID(),
				submittedAt: new Date().toISOString(),
				status: "New",
				...fields,
			});
			await writeResponses(responses);
			response.writeHead(303, { Location: "/jazzcontact.html?submitted=1" });
			response.end();
			return;
		}

		if (request.method === "GET" || request.method === "HEAD") {
			await serveFile(request, response, url.pathname);
			return;
		}

		response.writeHead(405);
		response.end("Method not allowed");
	} catch (error) {
		console.error(error);
		sendJson(response, 500, { error: "Unable to process the request." });
	}
});

const trashCleanup = setInterval(() => {
	readResponses().catch((error) => console.error("Unable to expire old requests:", error));
}, 60 * 1000);
trashCleanup.unref();

server.listen(port, "0.0.0.0", () => {
	console.log(`The music Collective is running at http://localhost:${port}`);
	console.log(`Request dashboard: http://localhost:${port}/responses.html`);
});