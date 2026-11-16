export function limitLabel(text: string, maxLabel: number): string {
  return maxLabel > 0 ? text.slice(0, maxLabel) : text
}

export function displayStatus(recording: boolean, selectedName: string | undefined, status: string, maxLabel: number): string {
  return limitLabel(recording ? `Recording for ${selectedName ?? ''}…` : status, maxLabel)
}
