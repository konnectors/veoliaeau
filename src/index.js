import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'
const log = Minilog('ContentScript')
Minilog.enable('veoliaeauCCC')

const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'veolia eau'
const BASE_URL = 'https://www.service.eau.veolia.fr'
// const WEBSITE_HOME_URL = `${BASE_URL}/home.html`
const LOGINFORM_URL = `${BASE_URL}/connexion-espace-client.html`
const HOMEPAGE_URL =
  'https://www.service.eau.veolia.fr/home/espace-client.html#inside-space'

class TemplateContentScript extends ContentScript {
  onWorkerReady() {
    if (
      document.readyState === 'complete' ||
      document.readyState === 'loaded'
    ) {
      this.setListeners()
    } else {
      window.addEventListener('DOMContentLoaded', () => {
        this.setListeners()
      })
    }
  }

  onWorkerEvent({ event, payload }) {
    this.log('info', 'onWorkerEvent starts')
    if (event === 'loginSubmit') {
      this.log('info', 'received loginSubmit, blocking user interactions')
      this.blockWorkerInteractions()
      const { login, password } = payload || {}
      if (login && password) {
        this.store.userCredentials = { login, password }
      }
    }
  }

  setListeners() {
    this.log('debug', '📍️ setListeners starts')
    const selectors = {
      email: '#identifiant',
      password: '#mot_passe',
      loginForm: '#connexionForm',
      loginButton: 'input[value="Me connecter"]',
      captchaButton: '.frc-button'
    }
    const form = document.querySelector(selectors.loginForm)
    if (form) {
      const passwordField = document.querySelector(selectors.password)
      const loginField = document.querySelector(selectors.email)
      const submitButton = document.querySelector(selectors.loginButton)
      if (submitButton) {
        submitButton.addEventListener('click', () => {
          this.log('info', 'Button click - emitting credentials')
          const password = passwordField?.value
          const login = loginField?.value
          if (password && login) {
            this.bridge.emit('workerEvent', {
              event: 'loginSubmit',
              payload: { login, password }
            })
          }
        })
      }
    }
  }
  // ////////
  // PILOT //
  // ////////
  async ensureAuthenticated({ account }) {
    this.log('info', 'Starting ensureAuthenticated')
    this.bridge.addEventListener('workerEvent', this.onWorkerEvent.bind(this))
    const credentials = await this.getCredentials()
    if (!account || !credentials) {
      await this.ensureNotAuthenticated()
    }
    if (
      await this.evaluateInWorker(() => {
        return !document.location.href === LOGINFORM_URL
      })
    ) {
      await this.navigateToLoginForm()
    }
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      if (credentials) {
        this.log('info', 'ensureAuthenticated - got credentials')
        await this.authWithCredentials(credentials)
        this.unblockWorkerInteractions()
        return true
      }
      this.log('info', 'ensureAuthenticated - No credentials found')
      await this.authWithoutCredentials()
      this.unblockWorkerInteractions()
    }
    return true
  }

  async navigateToLoginForm() {
    this.log('info', '📍️ navigateToLoginForm starts')
    await this.goto(LOGINFORM_URL)
    await Promise.race([
      this.waitForElementInWorker('.block-deconnecte'),
      this.waitForElementInWorker('#identifiant')
    ])
  }

  async ensureNotAuthenticated() {
    this.log('info', 'Starting ensureNotAuthenticated')
    await this.navigateToLoginForm()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not auth, returning true')
      return true
    }
    this.log('info', 'Seems like already logged, logging out')
    await this.clickAndWait(
      'input[value="Déconnexion"]',
      'a[href="/home/connexion-espace-client/locedvv.html"]'
    )
    return true
  }

  async authWithCredentials(credentials) {
    this.log('info', 'Starting authWithCredentials')
    await this.navigateToLoginForm()
    const isLogged = await this.runInWorker('checkIfLogged')
    if (isLogged) {
      await this.waitForElementInWorker(
        'a[href="/home/espace-client/vos-factures-et-correspondances.html"]'
      )
      return true
    }
    const isSuccess = await this.tryAutoLogin(credentials)
    if (isSuccess) {
      return true
    } else {
      this.log('info', 'Something went wrong while autoLogin, new auth needed')
      this.waitForUserAuthentication()
    }
  }

  async authWithoutCredentials() {
    this.log('info', 'Starting authWithoutCredentials')
    await this.navigateToLoginForm()
    await this.waitForUserAuthentication()
  }

  async waitForUserAuthentication() {
    this.log('info', 'Starting waitForUserAuthentication')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
    await this.unblockWorkerInteractions()
  }

  async getUserDataFromWebsite() {
    this.log('info', 'Starting getUserDataFromWebsite')
    await this.clickAndWait(
      'a[href="/home/espace-client/vos-contrats.html"]',
      '.bloc_princ'
    )
    await this.runInWorker('getUserBillingInfos')
    await this.clickAndWait(
      'a[href="/home/espace-client/gerer-votre-espace-personnel.html"]',
      '.fiche-client'
    )
    await this.runInWorker('getUserPersonalInfos')
    await this.runInWorker('computeIdentity', this.store)
    this.log(
      'info',
      `getUserDataFromWebsite - Boolean(this.store.userIdentity) : ${Boolean(
        this.store.userIdentity
      )}`
    )
    if (this.store.userIdentity.email) {
      return { sourceAccountIdentifier: this.store.userIdentity.email }
    } else {
      this.log('info', "Couldn't get a sourceAccountIdentifier, using default")
      return { sourceAccountIdentifier: DEFAULT_SOURCE_ACCOUNT_IDENTIFIER }
    }
  }

  async fetch(context) {
    this.log('info', 'Starting fetch')
    await this.runInWorker(
      'click',
      'a[href="/home/espace-client/vos-factures-et-correspondances.html"]'
    )
    await this.runInWorkerUntilTrue({
      method: 'checkBillsPage',
      args: [
        'https://www.service.eau.veolia.fr/home/espace-client/vos-factures-et-correspondances.html'
      ]
    })
    const moreBillsButton = await this.runInWorker('checkMoreBillsButton')
    this.log('info', `moreBillsButton : ${Boolean(moreBillsButton)}`)
    if (moreBillsButton) {
      await this.runInWorker(
        'click',
        'a[href="/home/espace-client/vos-factures-et-correspondances.html?voirPlus"]'
      )
      await this.runInWorkerUntilTrue({
        method: 'checkBillsPage',
        args: [
          'https://www.service.eau.veolia.fr/home/espace-client/vos-factures-et-correspondances.html?voirPlus'
        ]
      })
      await this.runInWorkerUntilTrue({ method: 'checkBillsTableLength' })
    }
    await this.runInWorker('getDocuments')
    if (this.store.userCredentials) {
      this.log('info', 'fetch - Cred found, saving ...')
      await this.saveCredentials(this.store.userCredentials)
    }
    this.log('info', 'fetch - Before Promise.all')
    await Promise.all([
      this.saveIdentity(this.store.userIdentity),
      this.saveFiles(this.store.files, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf'
      }),
      this.saveBills(this.store.bills, {
        context,
        fileIdAttributes: ['vendorRef'],
        contentType: 'application/pdf',
        qualificationLabel: 'water_invoice'
      })
    ])
  }

  async tryAutoLogin(credentials) {
    this.log('info', 'Trying autologin')
    const isSuccess = await this.autoLogin(credentials)
    return isSuccess
  }

  async autoLogin(credentials) {
    this.log('info', 'Starting autologin')
    const selectors = {
      email: '#identifiant',
      password: '#mot_passe',
      loginForm: '#connexionForm',
      loginButton: 'input[value="Me connecter"]',
      captchaButton: '.frc-button'
    }
    await this.waitForElementInWorker(selectors.captchaButton)
    await this.runInWorker('handleForm', { selectors, credentials })
    await this.runInWorkerUntilTrue({
      method: 'checkRecaptcha',
      args: [selectors]
    })
    await this.waitForElementInWorker(
      'a[href="/home/espace-client/vos-factures-et-correspondances.html"]'
    )
    return true
  }

  // ////////
  // WORKER//
  // ////////

  async checkAuthenticated() {
    this.log('info', 'Starting checkAuthenticated')
    this.log('info', `checkAuthenticated - location : ${window.location.href}`)
    if (
      document.location.href.includes(`${HOMEPAGE_URL}`) &&
      document.querySelector('.block-deconnecte')
    ) {
      this.log('info', 'Auth Check succeeded')
      return true
    }
    if (document.querySelector('input[value="Déconnexion"]')) {
      this.log('info', 'Detect active session')
      return true
    }
    if (document.querySelector('a[href*="/home/connexion-espace-client"]')) {
      this.log('info', 'loginFormButton detected, not connected')
      return false
    }
    this.log('info', 'Not respecting condition, returning false')
    return false
  }

  checkIfLogged() {
    this.log('info', 'Starting checkIfLogged')
    const loginEmailInput = document.querySelector('#identifiant')
    const logoutButton = document.querySelector('.block-deconnecte')
    if (loginEmailInput) {
      this.log('info', 'Login form detected, new auth needed')
      return false
    }
    if (logoutButton) {
      this.log('info', 'Still connected, continue')
      return true
    }
  }

  async handleForm(loginData) {
    this.log('info', 'Starting handleForm')
    const loginElement = document.querySelector(loginData.selectors.email)
    const passwordElement = document.querySelector(loginData.selectors.password)
    // Same here, second one is the one needed
    const captchaButton = document.querySelector(
      loginData.selectors.captchaButton
    )
    loginElement.value = loginData.credentials.login
    passwordElement.value = loginData.credentials.password
    captchaButton.click()
  }

  async checkRecaptcha(selectors) {
    this.log('info', 'Starting checkRecaptcha')
    await waitFor(
      () => {
        // Looks like they finally removed the other captcha
        let captchaValue = document.querySelector(
          'input[name="frc-captcha-solution"]'
        ).value
        if (captchaValue.startsWith('.')) {
          this.log('info', 'Recaptcha is not finished')
          return false
        } else {
          const submitButton = document
            .querySelector(selectors.loginForm)
            .querySelector(selectors.loginButton)
          submitButton.click()
          return true
        }
      },
      {
        interval: 1000,
        timeout: 30 * 1000
      }
    )
    return true
  }

  async getUserPersonalInfos() {
    this.log('info', 'Starting getUserPersonalInfos')
    const clientInfos = document.querySelectorAll('.ligne-info')
    const email = clientInfos[0].innerHTML.split(': ')[1]
    const homePhoneNumber = clientInfos[2].innerHTML.split(': ')[1]
    const mobilePhoneNumber = clientInfos[3].innerHTML.split(': ')[1]
    let userPersonalInfos = {
      email,
      phone: []
    }
    if (homePhoneNumber && homePhoneNumber !== '') {
      userPersonalInfos.phone.push({
        type: 'home',
        number: homePhoneNumber
      })
    }
    if (mobilePhoneNumber && mobilePhoneNumber !== '') {
      userPersonalInfos.phone.push({
        type: 'mobile',
        number: mobilePhoneNumber
      })
    }
    await this.sendToPilot({ userPersonalInfos })
  }

  async getUserBillingInfos() {
    this.log('info', 'Starting getUserBillingInfos')
    const billingInfosElements = document.querySelectorAll(
      'div[class="bloc_ct bloc_ct_1 bloc_contrat"]'
    )
    const rawContent = billingInfosElements[1].children[1].textContent
    const userBillingInfosArray = rawContent.match(/([A-Z0-9 -]{1,})/g)
    const [firstName, lastName] = userBillingInfosArray[1].split(' ')
    const street = `${userBillingInfosArray[2]} ${userBillingInfosArray[3]}`
    const postCode = userBillingInfosArray[4]
    const city = userBillingInfosArray[5]
    const userBillingInfos = {
      name: {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`
      },
      address: [
        {
          street,
          postCode,
          city,
          formattedAddress: `${street} ${postCode} ${city}`
        }
      ]
    }
    await this.sendToPilot({ userBillingInfos })
  }

  async computeIdentity(store) {
    this.log('info', 'Starting computeIdentity')
    const userIdentity = {
      ...store.userBillingInfos,
      ...store.userPersonalInfos
    }
    await this.sendToPilot({ userIdentity })
  }

  checkMoreBillsButton() {
    this.log('info', 'Starting checkMoreBillsButton')
    const moreBillsButton = document.querySelector(
      'a[href="/home/espace-client/vos-factures-et-correspondances.html?voirPlus"]'
    )
    if (moreBillsButton) return moreBillsButton
    return false
  }

  async checkBillsPage(testUrl) {
    this.log('info', 'Starting checkBillsPage')

    await waitFor(
      () => {
        const locationUrl = document.location.href
        const billsTable = document.querySelector('table')
        return locationUrl === testUrl && Boolean(billsTable)
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(`checkBillsPage timed out after 30000ms`)
        }
      }
    )
    return true
  }

  async checkBillsTableLength() {
    this.log('info', 'Starting checkBillsTableLength')
    await waitFor(
      () => {
        // As the website load another page with a different url, but with the same composition
        // the only way other than waiting for a selector to find out when the page is ready
        // is to check if the table length had increase above the last four bills/notice loaded on previous landing.
        const tableLength = document.querySelector('tbody').children.length
        if (tableLength > 4) {
          return true
        }
        return false
      },
      {
        interval: 1000,
        timeout: {
          milliseconds: 30000,
          message: new TimeoutError(`checkBillsPage timed out after 30000ms`)
        }
      }
    )
    return true
  }

  async getDocuments() {
    this.log('info', 'Starting getDocuments')
    let bills = []
    let files = []
    const documentsLines = document.querySelector('tbody').children
    for (const document of documentsLines) {
      const extractedDatas = await this.extractDatas(document)
      const computedFile = await this.computeDatas(extractedDatas)
      if (computedFile.documentType === 'Facture') {
        computedFile.vendorRef = `${computedFile.vendorRef}-F`
        bills.push(computedFile)
      } else {
        computedFile.vendorRef = `${computedFile.vendorRef}-C`
        files.push(computedFile)
      }
    }
    await Promise.all([
      this.sendToPilot({ bills }),
      this.sendToPilot({ files })
    ])
  }

  extractDatas(document) {
    this.log('info', 'Stating extractDatas')
    let documentDatas = []
    const datas = document.children
    for (const data of datas) {
      const hasChildren = data.children.length === 1 ? true : false
      if (hasChildren) {
        documentDatas.push(data.children[0].getAttribute('href'))
        break
      }
      documentDatas.push(data.innerHTML)
    }
    return documentDatas
  }

  computeDatas(datas) {
    this.log('info', 'Starting computeDatas')
    const [rawDate, documentType, vendorRef, rawAmount, href] = datas
    const refContract = document.querySelector('.ref_ct').innerHTML
    const [day, month, year] = rawDate.replace(/ /g, '').split('/')
    const date = `${year}/${month}/${day}`
    const vendor = 'veolia'
    let [amount, currency] = rawAmount.split(' ')
    const hasVendorRef = Boolean(vendorRef)
    this.log('info', `Boolean(vendorRef) : ${hasVendorRef}`)
    if (hasVendorRef) {
      this.log(
        'info',
        `vendorRef found - starting with : ${JSON.stringify(
          vendorRef.slice(0, 5)
        )}`
      )
    } else {
      this.log(
        'info',
        `No vendorRef found - Boolean(vendorRef) : ${hasVendorRef}`
      )
    }
    const computedFile = {
      date: new Date(date),
      documentType,
      vendorRef,
      vendor,
      fileurl: `https://www.service.eau.veolia.fr${href}`,
      fileAttributes: {
        metadata: {
          contentAuthor: 'veolia eau',
          datetime: new Date(),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(date),
          carbonCopy: true
        }
      }
    }
    if (amount !== '') {
      const normalizedCurrency = currency === '€' ? 'EUR' : currency
      computedFile.amount = parseFloat(amount)
      computedFile.currency = normalizedCurrency
      computedFile.filename = `${date.replace(
        /\//g,
        ''
      )}-${vendor.toLocaleUpperCase()}-${refContract.slice(
        2
      )}-${documentType}_${amount}${normalizedCurrency}.pdf`
      return computedFile
    } else {
      computedFile.filename = `${date.replace(
        '/',
        ''
      )}-${vendor.toLocaleUpperCase()}-${refContract.slice(
        2
      )}-${documentType}.pdf`
      return computedFile
    }
  }
}

const connector = new TemplateContentScript()
connector
  .init({
    additionalExposedMethodsNames: [
      'checkIfLogged',
      'handleForm',
      'getUserPersonalInfos',
      'getUserBillingInfos',
      'computeIdentity',
      'getDocuments',
      'checkMoreBillsButton',
      'checkBillsTableLength',
      'checkBillsPage',
      'checkRecaptcha'
    ]
  })
  .catch(err => {
    log.warn(err)
  })

// Keep this here for debugging purpose
// function sleep(delay) {
//   return new Promise(resolve => {
//     setTimeout(resolve, delay * 1000)
//   })
// }
