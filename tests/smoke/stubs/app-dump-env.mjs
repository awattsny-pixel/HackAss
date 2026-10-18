// Test hook: prints the environment it was given, then fails startup.
console.log('ENVDUMP:' + JSON.stringify(process.env));
process.exit(3);
