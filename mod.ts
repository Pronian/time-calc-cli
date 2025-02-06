import { parseArgs } from "jsr:@std/cli@^1.0.0";

function logFatal(message: string): never {
	console.error(`🔴 ${message}`);
	Deno.exit(1);
}

const args = parseArgs(Deno.args.slice(1));

if (!args._.length) {
	logFatal("Please enter the expression to calculate.");
}
const expression = args._[0].toString();

function parseDate(dateStr: string): Temporal.PlainDateTime {
	let datePart: string;
	let timePart = "00:00:00";
	if (dateStr.toUpperCase().includes("T")) {
		[datePart, timePart] = dateStr.toUpperCase().split("T");
	} else {
		datePart = dateStr;
	}

	const timeComponents = timePart.split(":");
	const hours = timeComponents[0] || "00";
	const minutes = timeComponents[1] || "00";
	const seconds = timeComponents[2] || "00";
	const normalizedTime = `${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}:${
		seconds.padStart(2, "0")
	}`;
	const normalizedIso = `${datePart}T${normalizedTime}`;
	return Temporal.PlainDateTime.from(normalizedIso);
}

function parseDuration(durationStr: string): Temporal.Duration {
	const upperStr = durationStr.toUpperCase();
	return Temporal.Duration.from(upperStr);
}

function durationToMs(duration: Temporal.Duration): number {
	return duration.round({ largestUnit: "milliseconds", smallestUnit: "milliseconds" }).milliseconds;
}

type Token = number | string | Temporal.PlainDateTime | Temporal.Duration;

function tokenize(expression: string): Token[] {
	const tokens: Token[] = [];
	const str = expression.replace(/\s+/g, "");
	let i = 0;

	while (i < str.length) {
		const char = str[i];

		if (/\d/.test(char)) {
			let dateMatch;
			const dateRegex = /^\d{4}-\d{2}-\d{2}(T(\d{2})(:\d{2}(:\d{2})?)?)?/i;
			if ((dateMatch = str.slice(i).match(dateRegex))) {
				const dateStr = dateMatch[0];
				try {
					const date = parseDate(dateStr);
					tokens.push(date);
					i += dateStr.length;
					continue;
				} catch {
					throw new Error(`Invalid date: ${dateStr}`);
				}
			}
		}

		if (str.startsWith("now", i) && (i + 3 >= str.length || !/\w/.test(str[i + 3]))) {
			tokens.push("now");
			i += 3;
			continue;
		}

		if (/[pP]/.test(char)) {
			let j = i;
			while (j < str.length && /[a-zA-Z0-9DTMHYS]/.test(str[j])) {
				j++;
			}
			const durationStr = str.substring(i, j);
			try {
				const duration = parseDuration(durationStr);
				tokens.push(duration);
				i = j;
				continue;
			} catch {
				throw new Error(`Invalid duration: ${durationStr}`);
			}
		}

		if (
			char === "-" || char === "+" || char === "*" || char === "/" || char === "(" || char === ")"
		) {
			if (char === "-") {
				const lastToken = tokens[tokens.length - 1];
				if (
					tokens.length === 0 ||
					(typeof lastToken === "string" && ["(", "+", "-", "*", "/"].includes(lastToken))
				) {
					tokens.push("u-");
				} else {
					tokens.push(char);
				}
			} else {
				tokens.push(char);
			}
			i++;
			continue;
		}

		if (char === ".") {
			let numStr = "";
			let hasDecimal = false;
			while (i < str.length) {
				const currentChar = str[i];
				if (currentChar === ".") {
					if (hasDecimal) break;
					hasDecimal = true;
					numStr += currentChar;
				} else if (/\d/.test(currentChar)) {
					numStr += currentChar;
				} else {
					break;
				}
				i++;
			}
			const num = parseFloat(numStr);
			if (isNaN(num)) {
				throw new Error(`Invalid number: ${numStr}`);
			}
			tokens.push(num);
			continue;
		}

		if (/\d/.test(char)) {
			let numStr = "";
			while (i < str.length && (/\d/.test(str[i]) || str[i] === ".")) {
				numStr += str[i];
				i++;
			}
			const num = parseFloat(numStr);
			if (isNaN(num)) {
				throw new Error(`Invalid number: ${numStr}`);
			}
			tokens.push(num);
			continue;
		}

		throw new Error(`Invalid character: ${char} at position ${i}`);
	}

	return tokens;
}

function infixToPostfix(tokens: Token[]): Token[] {
	const output: Token[] = [];
	const stack: string[] = [];
	const precedence: { [key: string]: number } = {
		"+": 1,
		"-": 1,
		"*": 2,
		"/": 2,
		"u-": 3,
	};

	for (const token of tokens) {
		if (
			typeof token === "number" || token instanceof Temporal.PlainDateTime ||
			token instanceof Temporal.Duration || token === "now"
		) {
			output.push(token);
		} else if (token === "(") {
			stack.push(token);
		} else if (token === ")") {
			while (stack.length > 0 && stack[stack.length - 1] !== "(") {
				output.push(stack.pop()!);
			}
			stack.pop();
		} else {
			const op = token;
			while (
				stack.length > 0 &&
				stack[stack.length - 1] !== "(" &&
				precedence[op] <= precedence[stack[stack.length - 1]]
			) {
				output.push(stack.pop()!);
			}
			stack.push(op);
		}
	}

	while (stack.length > 0) {
		output.push(stack.pop()!);
	}

	return output;
}

type CalcResult = Temporal.PlainDateTime | Temporal.Duration | number;

function evaluatePostfix(tokens: Token[]): CalcResult {
	const stack: CalcResult[] = [];

	for (const token of tokens) {
		if (
			typeof token === "number" || token instanceof Temporal.PlainDateTime ||
			token instanceof Temporal.Duration
		) {
			stack.push(token);
		} else if (token === "now") {
			stack.push(Temporal.Now.plainDateTimeISO());
		} else {
			if (token === "u-") {
				const operand = stack.pop();
				if (operand === undefined) {
					throw new Error("Invalid expression");
				}
				if (typeof operand === "number") {
					stack.push(-operand);
				} else if (operand instanceof Temporal.Duration) {
					const ms = durationToMs(operand);
					stack.push(Temporal.Duration.from({ milliseconds: -ms }));
				} else {
					throw new Error(`Cannot apply unary minus to ${operand.constructor.name} (${operand})`);
				}
			} else {
				const b = stack.pop();
				const a = stack.pop();
				if (a === undefined || b === undefined) {
					throw new Error("Invalid expression");
				}

				switch (token) {
					case "+":
						if (a instanceof Temporal.PlainDateTime && b instanceof Temporal.Duration) {
							stack.push(a.add(b));
						} else if (a instanceof Temporal.Duration && b instanceof Temporal.PlainDateTime) {
							stack.push(b.add(a));
						} else if (a instanceof Temporal.Duration && b instanceof Temporal.Duration) {
							stack.push(a.add(b));
						} else if (typeof a === "number" && typeof b === "number") {
							stack.push(a + b);
						} else {
							throw new Error(
								`Cannot add ${a.constructor.name} (${a}) and ${b.constructor.name} (${b})`,
							);
						}
						break;
					case "-":
						if (a instanceof Temporal.PlainDateTime && b instanceof Temporal.PlainDateTime) {
							stack.push(a.since(b));
						} else if (a instanceof Temporal.PlainDateTime && b instanceof Temporal.Duration) {
							stack.push(a.subtract(b));
						} else if (a instanceof Temporal.Duration && b instanceof Temporal.Duration) {
							stack.push(a.subtract(b));
						} else if (typeof a === "number" && typeof b === "number") {
							stack.push(a - b);
						} else {
							throw new Error(
								`Cannot subtract ${a.constructor.name} (${a}) and ${b.constructor.name} (${b})`,
							);
						}
						break;
					case "*":
						if (a instanceof Temporal.Duration && typeof b === "number") {
							const result = Math.round(durationToMs(a) * b);
							stack.push(Temporal.Duration.from({ milliseconds: result }));
						} else if (typeof a === "number" && b instanceof Temporal.Duration) {
							const result = Math.round(a * durationToMs(b));
							stack.push(Temporal.Duration.from({ milliseconds: result }));
						} else if (typeof a === "number" && typeof b === "number") {
							stack.push(a * b);
						} else {
							throw new Error(
								`Cannot multiply ${a.constructor.name} (${a}) and ${b.constructor.name} (${b})`,
							);
						}
						break;
					case "/":
						if (a instanceof Temporal.Duration && b instanceof Temporal.Duration) {
							const msA = durationToMs(a);
							const msB = durationToMs(b);
							if (msB === 0) throw new Error("Division by zero");
							const result = Math.round(msA / msB);
							stack.push(Temporal.Duration.from({ milliseconds: result }));
						} else if (a instanceof Temporal.Duration && typeof b === "number") {
							if (b === 0) throw new Error("Division by zero");
							const result = Math.round(durationToMs(a) / b);
							stack.push(Temporal.Duration.from({ milliseconds: result }));
						} else if (typeof a === "number" && typeof b === "number") {
							if (b === 0) throw new Error("Division by zero");
							stack.push(a / b);
						} else {
							throw new Error(
								`Cannot divide ${a.constructor.name} (${a}) by ${b.constructor.name} (${b})`,
							);
						}
						break;
					default:
						throw new Error(`Unknown operator: ${token}`);
				}
			}
		}
	}

	if (stack.length !== 1) {
		throw new Error("Invalid expression");
	}

	return stack[0];
}

function calculate(expression: string): CalcResult {
	try {
		const tokens = tokenize(expression);
		const postfix = infixToPostfix(tokens);
		return evaluatePostfix(postfix);
	} catch (error) {
		if (error instanceof Error) {
			logFatal(error.message);
		}
	}

	return 0;
}

function localizeResult(result: CalcResult): string {
	if (result instanceof Temporal.PlainDateTime) {
		return result.toLocaleString();
	} else if (result instanceof Temporal.Duration) {
		return result
			.round({ largestUnit: "day", smallestUnit: "second" })
			.toLocaleString();
	}
	return result.toString();
}

function printResult(result: CalcResult): void {
	console.log(`${localizeResult(result)} (${result.toString()})`);
}

printResult(calculate(expression));
