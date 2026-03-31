/**
 * Master email template skeletons for AI email generation.
 * These are extracted from real Stripo-produced Alconox emails
 * and provide the structural foundation that the AI fills in.
 */

const SHARED_ASSETS = {
  headerBanner: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/guids/CABINET_da586af97ffd40cfe5eb5e9fa8f288582f26248f8ef1cf8b94a4fdba8c5724a3/images/image.png',
  headerBannerWithShop: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/guids/CABINET_1a2fd7d3c199c315c97263fd2ba4ba0d0a05f5ec4f2b486dbf453671760aee55/images/alconoxemailheaderonlineorderingnowavailable.jpg',
  footerLogo: 'https://sagerock-email-images.s3.us-east-2.amazonaws.com/guids/CABINET_11ebec90034ce7770bd7228388158a587270f51e19fdafdd708858bd6c6da646/images/alconoxlogo.jpg',
  fbIcon: 'https://fjjangt.stripocdn.email/content/assets/img/social-icons/logo-colored/facebook-logo-colored.png',
  xIcon: 'https://fjjangt.stripocdn.email/content/assets/img/social-icons/logo-colored/x-logo-colored.png',
  ytIcon: 'https://fjjangt.stripocdn.email/content/assets/img/social-icons/logo-colored/youtube-logo-colored.png',
  liIcon: 'https://fjjangt.stripocdn.email/content/assets/img/social-icons/logo-colored/linkedin-logo-colored.png',
}

// Shared CSS that goes in <head> for all email types
const SHARED_HEAD_STYLES = `<style type="text/css">
.rollover:hover .rollover-first {
  max-height:0px!important;
  display:none!important;
}
.rollover:hover .rollover-second {
  max-height:none!important;
  display:block!important;
}
.rollover span {
  font-size:0px;
}
u + .body img ~ div div {
  display:none;
}
#outlook a {
  padding:0;
}
span.MsoHyperlink,
span.MsoHyperlinkFollowed {
  color:inherit;
  mso-style-priority:99;
}
a.es-button {
  mso-style-priority:100!important;
  text-decoration:none!important;
}
a[x-apple-data-detectors],
#MessageViewBody a {
  color:inherit!important;
  text-decoration:none!important;
  font-size:inherit!important;
  font-family:inherit!important;
  font-weight:inherit!important;
  line-height:inherit!important;
}
.es-desk-hidden {
  display:none;
  float:left;
  overflow:hidden;
  width:0;
  max-height:0;
  line-height:0;
  mso-hide:all;
}
.es-button-border:hover a.es-button,
.es-button-border:hover button.es-button,
.es-button-border:hover label.es-button {
  color:#ffffff!important;
}
@media only screen and (max-width:600px) {.es-m-p20b { padding-bottom:20px!important } .es-p-default { } *[class="gmail-fix"] { display:none!important } p, a { line-height:150%!important } h1, h1 a { line-height:120%!important } h2, h2 a { line-height:120%!important } h3, h3 a { line-height:120%!important } h4, h4 a { line-height:120%!important } h5, h5 a { line-height:120%!important } h6, h6 a { line-height:120%!important } .es-header-body p { } .es-content-body p { } .es-footer-body p { } .es-infoblock p { } h1 { font-size:40px!important; text-align:left } h2 { font-size:32px!important; text-align:left } h3 { font-size:28px!important; text-align:left } h4 { font-size:24px!important; text-align:left } h5 { font-size:20px!important; text-align:left } h6 { font-size:16px!important; text-align:left } .es-header-body h1 a, .es-content-body h1 a, .es-footer-body h1 a { font-size:40px!important } .es-header-body h2 a, .es-content-body h2 a, .es-footer-body h2 a { font-size:32px!important } .es-header-body h3 a, .es-content-body h3 a, .es-footer-body h3 a { font-size:28px!important } .es-header-body h4 a, .es-content-body h4 a, .es-footer-body h4 a { font-size:24px!important } .es-header-body h5 a, .es-content-body h5 a, .es-footer-body h5 a { font-size:20px!important } .es-header-body h6 a, .es-content-body h6 a, .es-footer-body h6 a { font-size:16px!important } .es-menu td a { font-size:14px!important } .es-header-body p, .es-header-body a { font-size:14px!important } .es-content-body p, .es-content-body a { font-size:14px!important } .es-footer-body p, .es-footer-body a { font-size:14px!important } .es-infoblock p, .es-infoblock a { font-size:12px!important } .es-m-txt-c, .es-m-txt-c h1, .es-m-txt-c h2, .es-m-txt-c h3, .es-m-txt-c h4, .es-m-txt-c h5, .es-m-txt-c h6 { text-align:center!important } .es-m-txt-r, .es-m-txt-r h1, .es-m-txt-r h2, .es-m-txt-r h3, .es-m-txt-r h4, .es-m-txt-r h5, .es-m-txt-r h6 { text-align:right!important } .es-m-txt-j, .es-m-txt-j h1, .es-m-txt-j h2, .es-m-txt-j h3, .es-m-txt-j h4, .es-m-txt-j h5, .es-m-txt-j h6 { text-align:justify!important } .es-m-txt-l, .es-m-txt-l h1, .es-m-txt-l h2, .es-m-txt-l h3, .es-m-txt-l h4, .es-m-txt-l h5, .es-m-txt-l h6 { text-align:left!important } .es-m-txt-r img, .es-m-txt-c img, .es-m-txt-l img { display:inline!important } .es-m-txt-r .rollover:hover .rollover-second, .es-m-txt-c .rollover:hover .rollover-second, .es-m-txt-l .rollover:hover .rollover-second { display:inline!important } .es-m-txt-r .rollover span, .es-m-txt-c .rollover span, .es-m-txt-l .rollover span { line-height:0!important; font-size:0!important; display:block } .es-spacer { display:inline-table } a.es-button, button.es-button, label.es-button { font-size:14px!important; padding:10px 20px 10px 20px!important; line-height:120%!important } a.es-button, button.es-button, label.es-button, .es-button-border { display:inline-block!important } .es-m-fw, .es-m-fw.es-fw, .es-m-fw .es-button { display:block!important } .es-m-il, .es-m-il .es-button, .es-social, .es-social td, .es-menu.es-table-not-adapt { display:inline-block!important } .es-adaptive table, .es-left, .es-right { width:100%!important } .es-content table, .es-header table, .es-footer table, .es-content, .es-footer, .es-header { width:100%!important; max-width:600px!important } .adapt-img { width:100%!important; height:auto!important } .es-adapt-td { display:block!important; width:100%!important } .es-mobile-hidden, .es-hidden { display:none!important } .es-container-hidden { display:none!important } .es-desk-hidden { width:auto!important; overflow:visible!important; float:none!important; max-height:inherit!important; line-height:inherit!important } tr.es-desk-hidden { display:table-row!important } table.es-desk-hidden { display:table!important } td.es-desk-hidden { display:table-cell!important } td.es-desk-menu-hidden { display:table-cell!important } .es-menu td { width:1%!important } table.es-table-not-adapt, .esd-block-html table { width:auto!important } .h-auto { height:auto!important } a.es-button, button.es-button, .es-button-border { display:inline-block!important } }
@media screen and (max-width:384px) {.mail-message-content { width:414px!important } }
</style>`

// Shared footer HTML used by all email types
function getSharedFooter() {
  return `<table align="center" cellspacing="0" cellpadding="0" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
           </table></td>
         </tr>
       </table>
       <table cellspacing="0" cellpadding="0" align="center" class="es-footer" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;width:100%;table-layout:fixed !important;background-color:transparent">
         <tr>
          <td align="center" style="padding:0;Margin:0">
           <table cellspacing="0" cellpadding="0" bgcolor="#ffffff" align="center" class="es-footer-body" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;background-color:#FFFFFF;width:600px">
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-right:20px;padding-left:20px">
               <table width="100%" cellpadding="0" cellspacing="0" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                 <tr>
                  <td align="left" style="padding:0;Margin:0;width:560px">
                   <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                     <tr>
                      <td align="center" style="padding:20px;Margin:0;font-size:0">
                       <table cellpadding="0" cellspacing="0" border="0" width="100%" height="100%" class="es-spacer" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                         <tr>
                          <td style="padding:0;Margin:0;border-bottom:1px solid #cccccc;background:none;height:0px;width:100%;margin:0px"></td>
                         </tr>
                       </table></td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-right:20px;padding-left:20px"><!--[if mso]><table style="width:560px" cellpadding="0" cellspacing="0"><tr><td style="width:366px" valign="top"><![endif]-->
               <table cellpadding="0" cellspacing="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                 <tr>
                  <td align="left" class="es-m-p20b" style="padding:0;Margin:0;width:366px">
                   <table width="100%" cellpadding="0" cellspacing="0" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                     <tr>
                      <td align="left" style="padding:0;Margin:0"><p style="Margin:0;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;letter-spacing:0;color:#333333;font-size:14px"><a target="_blank" href="https://alconox.com/ask-alconox/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px">Ask Alconox</a> | <a target="_blank" href="https://alconox.com/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px">Contact Us</a> | <a target="_blank" href="{{unsubscribe_url}}" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px">Unsubscribe</a></p></td>
                     </tr>
                   </table></td>
                 </tr>
               </table><!--[if mso]></td><td style="width:20px"></td><td style="width:174px" valign="top"><![endif]-->
               <table cellpadding="0" cellspacing="0" align="right" class="es-right" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:right">
                 <tr>
                  <td align="left" style="padding:0;Margin:0;width:174px">
                   <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                     <tr>
                      <td align="center" style="padding:0;Margin:0;font-size:0">
                       <table cellpadding="0" cellspacing="0" class="es-table-not-adapt es-social" role="presentation" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                         <tr>
                          <td align="center" valign="top" style="padding:0;Margin:0;padding-right:10px"><a target="_blank" href="https://www.facebook.com/alconox" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><img src="${SHARED_ASSETS.fbIcon}" alt="Fb" width="32" height="32" title="Facebook" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></a></td>
                          <td valign="top" align="center" style="padding:0;Margin:0;padding-right:10px"><a target="_blank" href="https://x.com/alconox" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><img width="32" height="32" title="X" src="${SHARED_ASSETS.xIcon}" alt="X" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></a></td>
                          <td align="center" valign="top" style="padding:0;Margin:0;padding-right:10px"><a href="https://www.youtube.com/@alconoxllc" target="_blank" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><img alt="Yt" width="32" height="32" title="YouTube" src="${SHARED_ASSETS.ytIcon}" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></a></td>
                          <td align="center" valign="top" style="padding:0;Margin:0"><a target="_blank" href="https://www.linkedin.com/company/alconox-inc-/" style="mso-line-height-rule:exactly;text-decoration:underline;color:#1376C8;font-size:14px"><img height="32" title="LinkedIn" src="${SHARED_ASSETS.liIcon}" alt="In" width="32" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></a></td>
                         </tr>
                       </table></td>
                     </tr>
                   </table></td>
                 </tr>
               </table><!--[if mso]></td></tr></table><![endif]--></td>
             </tr>
             <tr>
              <td align="left" style="Margin:0;padding-top:20px;padding-right:20px;padding-left:20px;padding-bottom:20px">
               <table cellspacing="0" cellpadding="0" align="left" class="es-left" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px;float:left">
                 <tr>
                  <td align="left" class="es-m-p20b" style="padding:0;Margin:0;width:560px">
                   <table cellspacing="0" role="presentation" width="100%" cellpadding="0" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                     <tr>
                      <td align="center" style="padding:0;Margin:0;font-size:0"><img width="150" src="${SHARED_ASSETS.footerLogo}" alt="" style="display:block;font-size:14px;border:0;outline:none;text-decoration:none;margin:0"></td>
                     </tr>
                     <tr>
                      <td align="center" style="padding:0;Margin:0"><p style="Margin:0;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;letter-spacing:0;color:#333333;font-size:14px"><strong style="font-weight:700 !important">Contact Us</strong> <br>Alconox, LLC <br>30 Glenn Street, Suite 309 <br>White Plains, NY 10603 USA <br>Email: cleaning@alconox.com <br>Phone: 914-948-4040 <br>FAX: 914-948-4088</p><p style="Margin:0;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;letter-spacing:0;color:#333333;font-size:14px"><br></p></td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
             <tr>
              <td align="left" style="padding:0;Margin:0;padding-top:20px;padding-right:20px;padding-left:20px">
               <table cellpadding="0" cellspacing="0" width="100%" role="none" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                 <tr>
                  <td align="left" style="padding:0;Margin:0;width:560px">
                   <table cellpadding="0" cellspacing="0" role="presentation" width="100%" style="mso-table-lspace:0pt;mso-table-rspace:0pt;border-spacing:0px">
                     <tr>
                      <td align="left" style="padding:0;Margin:0"><p style="Margin:0;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;letter-spacing:0;color:#333333;font-size:14px">This email was sent to {{email}}</p><p style="Margin:0;mso-line-height-rule:exactly;font-family:arial, 'helvetica neue', helvetica, sans-serif;line-height:21px;letter-spacing:0;color:#333333;font-size:14px">This email was sent by: Alconox, LLC<br>{{mailing_address}}</p></td>
                     </tr>
                   </table></td>
                 </tr>
               </table></td>
             </tr>
           </table></td>
         </tr>
       </table>`
}

// Document head shared across all types
function getDocumentHead(title) {
  return `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">
<html dir="ltr" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office" lang="en">
 <head>
  <meta charset="UTF-8">
  <meta content="width=device-width, initial-scale=1" name="viewport">
  <meta name="x-apple-disable-message-reformatting">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <meta content="telephone=no" name="format-detection">
  <title>${title}</title><!--[if (mso 16)]>
    <style type="text/css">
    a {text-decoration: none;}
    </style>
    <![endif]--><!--[if gte mso 9]><style>sup { font-size: 100% !important; }</style><![endif]--><!--[if gte mso 9]>
<noscript>
         <xml>
           <o:OfficeDocumentSettings>
           <o:AllowPNG></o:AllowPNG>
           <o:PixelsPerInch>96</o:PixelsPerInch>
           </o:OfficeDocumentSettings>
         </xml>
      </noscript>
<![endif]--><!--[if mso]><xml>
    <w:WordDocument xmlns:w="urn:schemas-microsoft-com:office:word">
      <w:DontUseAdvancedTypographyReadingMail/>
    </w:WordDocument>
    </xml><![endif]-->
  ${SHARED_HEAD_STYLES}
 </head>`
}

function getEmailTypeDescription(emailType) {
  const descriptions = {
    'pre-tradeshow': `PRE-TRADESHOW ANNOUNCEMENT EMAIL
Structure: Alconox header banner -> city/venue hero image -> event details paragraph (show name, dates, location, booth number) -> orange CTA button inviting them to meet at the show -> footer
CTA button style: background #ff6900, border-radius 15px, bold white text, text like "Click Here To Meet Us At The Show AND GET A FREE GIFT!"
Tone: Exciting, inviting, professional. Mention booth number prominently.
The hero image should be a photo related to the show city/venue.
Do NOT use {{first_name}} - this goes to a general audience.`,

    'post-tradeshow': `POST-TRADESHOW FOLLOW-UP EMAIL
Structure: Alconox header banner (with "Online Ordering Now Available") -> product/team hero image -> personalized greeting "Hi {{first_name}}," -> thank-you message referencing the show -> discount code offer -> dark red CTA button to shop -> footer
CTA button style: background #990000, border-radius 4px, bold white text, text like "Shop Alconox Here"
Tone: Warm, personal, grateful. Reference the specific show. Include a discount code with expiration.
MUST use {{first_name}} in the greeting - these go to people we met at the show.`,

    'newsletter': `MONTHLY NEWSLETTER EMAIL
Structure: Alconox header banner -> hero image (industry/product related) -> featured article section with H2 heading + body paragraph + link -> 3 article cards (each with: 250px image on left, title + "Read More" button on right) -> "Ask Alconox" CTA section -> footer
Article card layout: two-column table, image 250px left column, title (H2, 25px) + blue "Read More" button in 330px right column
"Read More" button style: background #0176d3, border-radius 5px, bold white text
"Ask Alconox" CTA: centered text "Do you have a critical cleaning question for the experts at Alconox, LLC?" + blue button
Tone: Educational, informative. Feature TechNotes articles and cleaning tips.
Do NOT use {{first_name}} - this goes to a general audience.`
  }
  return descriptions[emailType] || descriptions['pre-tradeshow']
}

module.exports = {
  SHARED_ASSETS,
  getDocumentHead,
  getSharedFooter,
  getEmailTypeDescription,
}
