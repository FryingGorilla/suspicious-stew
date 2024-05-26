const fs = require("fs");
const path = require("path");
const { promisify } = require("util");
const exec = promisify(require("child_process").exec);
const crypto = require("crypto");

main();

function calculateSHA256(filePath) {
	return new Promise((resolve, reject) => {
		const hash = crypto.createHash("sha256");
		const stream = fs.createReadStream(filePath);

		stream.on("data", (chunk) => hash.update(chunk));
		stream.on("error", reject);
		stream.on("end", () => resolve(hash.digest("hex")));
	});
}

async function main() {
	const start = Date.now();
	console.log("Uploading executables...");

	const { stdout } = await exec("gh release list");
	const tag = stdout.split("\t")[0];
	const ver = tag.replace("v", "");

	if (!tag) {
		console.error("No tag found");
		return;
	}

	const executables = path.join(__dirname, "../executables");
	if (!fs.existsSync(executables)) {
		console.error("No executables found");
		return;
	}

	const files = fs
		.readdirSync(executables, { recursive: true, withFileTypes: true })
		.filter((d) => d.isFile())
		.filter((d) => d.name.includes(ver))
		.map((d) => path.join(d.path, d.name));

	const sumFile = path.join(__dirname, "sha256sum.txt");

	const json =
		"{" +
		(await Promise.all(
			files.map(
				async (file) =>
					`"${path.parse(file).base}": "${await calculateSHA256(file)}"`
			)
		)) +
		"}";
	fs.writeFileSync(sumFile, json);

	const { stderr } = await exec(
		`gh release upload ${tag} ${files.join(" ")} ${sumFile} --clobber`
	);
	fs.rmSync(sumFile);

	if (stderr) {
		console.error(stderr);
	} else {
		console.log(
			"Finished uploading executables in " +
				((Date.now() - start) / 1000).toFixed(2) +
				"s"
		);
	}
}
