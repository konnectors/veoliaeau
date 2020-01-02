process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://d93531893f77451baaf5b5547edc8429:6654060edee54f19aa8842f790c8bbb1@sentry.cozycloud.cc/55'

const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const request = requestFactory({
  // debug: true,
  cheerio: true,
  json: false,
  jar: true
})

const baseUrl = 'https://www.service.eau.veolia.fr'
const vendor = 'veolia'

module.exports = new BaseKonnector(start)

async function start(fields) {
  await this.deactivateAutoSuccessfulLogin()
  if (fields.log.match(/^\d{7}$/)) {
    log('warn', "Detect account with 7 digits, it's a regional veolia website account,"
        + " not implemented")
    throw new Error('LOGIN_FAILED.ACCOUNT_TYPE_NOT_IMPLEMENTED')
  }
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  await this.notifySuccessfulLogin()
  log('info', 'Successfully logged in')

  // Several contracts can be attached to the same account, each contract having
  // its own set of bills.
  log('info', 'Fetching list of contracts')
  const contractsPaths = await getContractsPaths()

  log('info', 'Fetching bills')
  const bills = await fetchAllBills(contractsPaths)

  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields.folderPath, {
    contentType: 'application/pdf',
    linkBankOperations: false,
    sourceAccount: this.accountId,
    sourceAccountIdentifier: fields.login
  })
}

async function authenticate(username, password) {
  const url = `${baseUrl}/home.html`
  // In order to accept a login request at least one of the two cookies are
  // needed: 'JSESSIONID' and 'AWSELB'.
  // If none are set then there is a redirection to the "create an account"
  // page.
  const $ = await request(url)
  // We also need to extract the token located in a hidden field of the form.
  const token = $("input[name='token']").attr('value')

  return signin({
    url,
    formSelector: '#loginBoxform_identification',
    formData: {
      token,
      veolia_username: username,
      veolia_password: password,
      login: 'OK'
    },
    validate: (statusCode, $) => {
      if ($(`.block-deconnecte`).length === 1) {
        return true
      } else {
        log('error', $('.error').text())
        return false
      }
    }
  })
}

async function getContractsPaths() {
  const $ = await request(
    `${baseUrl}/home/espace-client/vos-factures-et-correspondances.html`
  )

  return $('.divToggle ul li a')
    .map(function(i, el) {
      return $(el).attr('href')
    })
    .get()
}

async function fetchBillsForContract(contractPath) {
  const $ = await request(`${baseUrl}${contractPath}`)

  const refContract = contractPath
    // The path has the following format: '[...].setContrat.do?idContrat=xxxxxxx'.
    // We are interested in the 'xxxxxxx' part.
    .split('idContrat=')[1]
    // The first two number of the 'xxxxxxx' are not included in the contract
    // reference number, so we remove them.
    .slice(2)

  return scrape(
    $,
    {
      date: {
        sel: 'td:nth-child(1)',
        parse: text => text.replace(/ \/ /g, '-').trim()
      },
      type: {
        sel: 'td:nth-child(2)'
      },
      billNumber: {
        sel: 'td:nth-child(3)'
      },
      amount: {
        sel: 'td:nth-child(4)',
        parse: text => text.split(' € ')[0]
      },
      billPath: {
        sel: 'td:nth-child(5) a',
        attr: 'href'
      }
    },
    '.liste-table table tbody tr'
  ).map(bill => {
    return {
      ...bill,
      refContract,
      date: normalizeDate(bill.date),
      amount: parseFloat(bill.amount)
    }
  })
}

// CAVEAT: not all "bills" have an amount associated, as some are not
// technically bills but regular mails or notices.
async function fetchAllBills(contractsPaths) {
  const bills = []

  for (let contractPath of contractsPaths) {
    Array.prototype.push.apply(bills, await fetchBillsForContract(contractPath))
  }

  return bills.map(bill => {
    let filename = `${formatDate(bill.date)}-${vendor.toUpperCase()}-${
      bill.refContract
    }-${bill.type}`
    if (bill.type === 'Facture') {
      // Some bills have a negative amount, I think its clearer to add an
      // underscore here.
      filename += `_${bill.amount}EUR`
    }
    filename += '.pdf'

    return {
      ...bill,
      currency: '€',
      fileurl: `${baseUrl}${bill.billPath}`,
      filename,
      vendor
    }
  })
}

// "Parse" the date found in the bill page and return a JavaScript Date object.
function normalizeDate(date) {
  const [day, month, year] = date.split('-')
  return new Date(`${year}-${month}-${day}`)
}

// Return a string representation of the date that follows this format:
// "YYYY-MM-DD". Leading "0" for the day and the month are added if needed.
function formatDate(date) {
  let month = date.getMonth() + 1
  if (month < 10) {
    month = '0' + month
  }

  let day = date.getDate()
  if (day < 10) {
    day = '0' + day
  }

  let year = date.getFullYear()

  return `${year}${month}${day}`
}
