const fs = require('fs');
const path = require('path');
const {promisify} = require('util');
const exec = promisify(require('child_process').exec);

main();

async function main() {
	const start = Date.now();
	console.log('Uploading executables...');

	const {stdout} = await exec('gh release list');
	const tag = stdout.split('\t')[0];
	if (!tag) {
		console.error('No tag found');
		return;
	}

	const executables = path.join(__dirname, '../executables');
	if (!fs.existsSync(executables)) {
		console.error('No executables found');
		return;
	}

	const files = fs
		.readdirSync(executables, {recursive: true, withFileTypes: true})
		.filter((d) => d.isFile())
		.map((d) => path.join(d.path, d.name));

	const {stderr} = await exec(`gh release upload ${tag} ${files.join(' ')} --clobber`);

	if (stderr) {
		console.error(stderr);
	} else {
		console.log('Finished uploading executables in ' + ((Date.now() - start) / 1000).toFixed(2) + 's');
	}
}
