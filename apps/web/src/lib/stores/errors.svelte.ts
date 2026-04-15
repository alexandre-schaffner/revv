export type AppError = {
	message: string;
	code?: string;
	retryAfter?: number;
};

let currentError = $state<AppError | null>(null);
let retryCountdown = $state<number>(0);

let countdownTimer: ReturnType<typeof setInterval> | null = null;

export function setError(error: AppError): void {
	currentError = error;
	if (error.retryAfter && error.retryAfter > 0) {
		retryCountdown = error.retryAfter;
		if (countdownTimer) clearInterval(countdownTimer);
		countdownTimer = setInterval(() => {
			retryCountdown = Math.max(0, retryCountdown - 1);
			if (retryCountdown === 0) {
				if (countdownTimer) {
					clearInterval(countdownTimer);
					countdownTimer = null;
				}
			}
		}, 1000);
	}
}

export function clearError(): void {
	currentError = null;
	retryCountdown = 0;
	if (countdownTimer) {
		clearInterval(countdownTimer);
		countdownTimer = null;
	}
}

export function getError(): AppError | null {
	return currentError;
}

export function getCountdown(): number {
	return retryCountdown;
}
