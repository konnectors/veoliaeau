const {
  BaseKonnector,
  requestFactory,
  signin,
  scrape,
  saveBills,
  log
} = require('cozy-konnector-libs')

const request = requestFactory({
  // the debug mode shows all the details about http request and responses. Very usefull for
  // debugging but very verbose. That is why it is commented out by default
  // debug: true,
  // activates [cheerio](https://cheerio.js.org/) parsing on each page
  cheerio: true,
  // If cheerio is activated do not forget to deactivate json parsing (which is activated by
  // default in cozy-konnector-libs
  json: false,
  // this allows request-promise to keep cookies between requests
  jar: true
})

const baseUrl = 'https://www.service.eau.veolia.fr'
const vendor = 'veolia-eau'

module.exports = new BaseKonnector(start)

// The start function is run by the BaseKonnector instance only when it got all the account
// information (fields). When you run this connector yourself in "standalone" mode or "dev" mode,
// the account information come from ./konnector-dev-config.json file
async function start(fields) {
  log('info', 'Authenticating ...')
  await authenticate(fields.login, fields.password)
  log('info', 'Successfully logged in')

  // Several contracts can be attached to a same account, each contract having
  // its own set of invoices.
  log('info', 'Fetching the list of contracts')
  const contractsPaths = await getContractsPaths()

  log('info', 'Fetching the bills')
  const bills = await fetchAllBills(contractsPaths)

  // here we use the saveBills function even if what we fetch are not bills, but this is the most
  // common case in connectors
  log('info', 'Saving data to Cozy')
  await saveBills(bills, fields.folderPath, {
    // this is a bank identifier which will be used to link bills to bank operations. These
    // identifiers should be at least a word found in the title of a bank operation related to this
    // bill. It is not case sensitive.
    identifiers: [vendor]
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
    // reference number displayed so we remove them.
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

async function fetchAllBills(contractsPaths) {
  const bills = []

  for (let contractPath of contractsPaths) {
    Array.prototype.push.apply(bills, await fetchBillsForContract(contractPath))
  }

  return bills.filter(bill => bill.type === 'Facture').map(bill => ({
    ...bill,
    currency: '€',
    fileurl: `${baseUrl}${bill.billPath}`,
    vendor,
    filename: `${bill.refContract}-${formatDate(bill.date)}-${
      bill.billNumber
    }-${bill.amount}EUR.pdf`,
    metadata: {
      importDate: new Date(),
      version: 1
    }
  }))
}

function normalizeDate(date) {
  const customDate = date.split('-')
  return new Date(`${customDate[2]}-${customDate[1]}-${customDate[0]}`)
}

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
