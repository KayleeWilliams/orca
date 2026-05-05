export async function playDesktopNotificationSound(
  customSoundPath: string | null | undefined
): Promise<boolean> {
  if (!customSoundPath) {
    return false
  }

  try {
    const result = await window.api.notifications.playSound()
    if (!result.played) {
      console.warn('Failed to play custom notification sound:', result.reason)
    }
    return result.played
  } catch (err) {
    console.warn('Failed to play custom notification sound:', err)
    return false
  }
}
