/**
 * Generate unsubscribe URL for a contact
 * @param unsubscribeToken - The contact's unique unsubscribe token
 * @param baseUrl - Base URL of your application (e.g., https://yourdomain.com)
 * @returns Full unsubscribe URL
 */
export function generateUnsubscribeUrl(
  unsubscribeToken: string,
  baseUrl: string = window.location.origin
): string {
  return `${baseUrl}/unsubscribe?token=${unsubscribeToken}`
}

/**
 * Replace merge tags in email HTML with actual values
 * @param html - Email HTML content
 * @param mergeData - Object containing merge tag values
 * @returns HTML with replaced merge tags
 */
export function replaceMergeTags(
  html: string,
  mergeData: {
    email: string
    first_name?: string
    last_name?: string
    unsubscribe_url: string
    [key: string]: any
  }
): string {
  let processedHtml = html

  // Replace common merge tags
  Object.entries(mergeData).forEach(([key, value]) => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'gi')
    processedHtml = processedHtml.replace(regex, value || '')
  })

  return processedHtml
}

/**
 * Validate that email HTML contains unsubscribe link
 * @param html - Email HTML content
 * @returns true if unsubscribe link found
 */
export function hasUnsubscribeLink(html: string): boolean {
  return /{{.*unsubscribe.*}}/i.test(html)
}
