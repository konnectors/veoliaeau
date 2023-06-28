import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
const log = Minilog('ContentScript')
Minilog.enable('veoliaeauCCC')

const DEFAULT_SOURCE_ACCOUNT_IDENTIFIER = 'veolia eau'
const BASE_URL = 'https://www.service.eau.veolia.fr/home.html'
const HOMEPAGE_URL =
  'https://www.service.eau.veolia.fr/home/espace-client.html#inside-space'

class TemplateContentScript extends ContentScript {
  // ////////
  // PILOT //
  // ////////
  async ensureAuthenticated() {
    this.log('debug', 'Starting ensureAuthenticated')
    await this.goto(BASE_URL)
    await this.waitForElementInWorker('.inside-space')
    await this.ensureNotAuthenticated()
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('info', 'Not authenticated')
      const credentials = await this.getCredentials()
      if (credentials) {
        await this.authWithCredentials(credentials)
        return true
      }
      await this.authWithoutCredentials()
    }
    return true
  }

  async ensureNotAuthenticated() {
    this.log('debug', 'Starting ensureNOTAuthenticated')
    await this.goto(BASE_URL)
    const authenticated = await this.runInWorker('checkAuthenticated')
    if (!authenticated) {
      this.log('debug', 'Not auth, returning true')
      return true
    }
    this.log('debug', 'Seems like already logged, logging out')
    await this.clickAndWait(
      'input[value="Déconnexion"]',
      '#loginBoxform_identification'
    )
    return true
  }

  async authWithCredentials(credentials) {
    this.log('debug', 'Starting authWithCredentials')
    await this.waitForElementInWorker('.block-bottom-area')
    const isLogged = await this.runInWorker('checkIfLogged')
    if (isLogged) {
      await this.runInWorker('click', 'a[href="/home/espace-client.html"]')
      await this.waitForElementInWorker(
        'a[href="/home/espace-client/vos-factures-et-correspondances.html"]'
      )
      return true
    }
    const isSuccess = await this.tryAutoLogin(credentials)
    if (isSuccess) {
      return true
    } else {
      this.log('debug', 'Something went wrong while autoLogin, new auth needed')
      this.waitForUserAuthentication()
    }
  }

  async authWithoutCredentials() {
    this.log('debug', 'Starting authWithoutCredentials')
    await this.waitForElementInWorker('#veolia_username')
    await this.waitForUserAuthentication()
  }

  async waitForUserAuthentication() {
    this.log('debug', 'Starting waitForUserAuthentication')
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({ method: 'waitForAuthenticated' })
    await this.setWorkerState({ visible: false })
  }

  async getUserDataFromWebsite() {
    this.log('debug', 'Starting getUserDataFromWebsite')
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
    if (this.store.userIdentity.email) {
      return { sourceAccountIdentifier: this.store.userIdentity.email }
    } else {
      this.log('debug', "Couldn't get a sourceAccountIdentifier, using default")
      return { sourceAccountIdentifier: DEFAULT_SOURCE_ACCOUNT_IDENTIFIER }
    }
  }

  async fetch(context) {
    this.log('debug', 'Starting fetch')
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
      await this.saveCredentials(this.store.userCredentials)
    }
    await Promise.all([
      this.saveIdentity(this.store.userIdentity),
      this.saveFiles(this.store.files, {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf'
      }),
      this.saveBills(this.store.bills, {
        context,
        fileIdAttributes: ['filename'],
        contentType: 'application/pdf',
        qualificationLabel: 'water_invoice'
      })
    ])
  }

  async tryAutoLogin(credentials) {
    this.log('debug', 'Trying autologin')
    const isSuccess = await this.autoLogin(credentials)
    return isSuccess
  }

  async autoLogin(credentials) {
    this.log('debug', 'Starting autologin')
    const selectors = {
      email: '#veolia_username',
      password: '#veolia_password',
      loginForm: '#loginBoxform_identification',
      loginButton: 'input[value="OK"]',
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
    this.log('debug', 'Starting checkAuthenticated')
    const loginField = document.querySelector('#veolia_username')
    const passwordField = document.querySelector('#veolia_password')
    if (
      loginField &&
      passwordField &&
      loginField.value !== 'Votre adresse mail' &&
      passwordField.value !== 'Identifiant'
    ) {
      const userCredentials = await this.findAndSendCredentials.bind(this)(
        loginField,
        passwordField
      )
      this.log('debug', 'Sendin userCredentials to Pilot')
      this.sendToPilot({
        userCredentials
      })
    }
    if (
      document.location.href.includes(`${HOMEPAGE_URL}`) &&
      document.querySelector('.block-deconnecte')
    ) {
      this.log('debug', 'Auth Check succeeded')
      return true
    }
    if (document.querySelector('input[value="Déconnexion"]')) {
      this.log('debug', 'Detect active session')
      return true
    }
    this.log('debug', 'Not respecting condition, returning false')
    return false
  }

  async findAndSendCredentials(login, password) {
    this.log('debug', 'Starting findAndSendCredentials')
    let userLogin = login.value
    let userPassword = password.value
    const userCredentials = {
      login: userLogin,
      password: userPassword
    }
    return userCredentials
  }

  checkIfLogged() {
    this.log('debug', 'Starting checkIfLogged')
    const loginForm = document.querySelector('#loginBoxform_identification')
    const logoutButton = document.querySelector('.block-deconnecte')
    if (loginForm) {
      this.log('debug', 'Login form detected, new auth needed')
      return false
    }
    if (logoutButton) {
      this.log('debug', 'Still connected, continue')
      return true
    }
  }

  async handleForm(loginData) {
    this.log('debug', 'Starting handleForm')
    const loginElement = document.querySelector(loginData.selectors.email)
    const passwordElement = document.querySelector(loginData.selectors.password)
    const captchaButton = document.querySelector(
      loginData.selectors.captchaButton
    )
    loginElement.value = loginData.credentials.login
    passwordElement.value = loginData.credentials.password
    captchaButton.click()
  }

  async checkRecaptcha(selectors) {
    this.log('debug', 'Starting checkRecaptcha')
    let captchaValue = document.querySelector(
      'input[name="frc-captcha-solution"]'
    ).value
    if (captchaValue.length < 100) {
      this.log('debug', 'Recaptcha is not finished')
      return false
    } else {
      const submitButton = document
        .querySelector(selectors.loginForm)
        .querySelector(selectors.loginButton)
      submitButton.click()
      return true
    }
  }

  async getUserPersonalInfos() {
    this.log('debug', 'Starting getUserPersonalInfos')
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
    this.log('debug', 'Starting getUserBillingInfos')
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
    this.log('debug', 'Starting computeIdentity')
    const userIdentity = {
      ...store.userBillingInfos,
      ...store.userPersonalInfos
    }
    await this.sendToPilot({ userIdentity })
  }

  checkMoreBillsButton() {
    this.log('debug', 'Starting checkMoreBillsButton')
    const moreBillsButton = document.querySelector(
      'a[href="/home/espace-client/vos-factures-et-correspondances.html?voirPlus"]'
    )
    if (moreBillsButton) return moreBillsButton
    return false
  }

  async checkBillsPage(testUrl) {
    this.log('debug', 'Starting checkBillsPage')
    const locationUrl = document.location.href
    const billsTable = document.querySelector('table')
    if (locationUrl === testUrl && billsTable) {
      return true
    }
    return false
  }

  async checkBillsTableLength() {
    this.log('debug', 'Starting checkBillsTableLength')
    // As the website load another page with a different url, but with the same composition
    // the only way other than waiting for a selector to find out when the page is ready
    // is to check if the table length had increase above the last four bills/notice loaded on previous landing.
    const tableLength = document.querySelector('tbody').children.length
    if (tableLength > 4) {
      return true
    }
    return false
  }

  async getDocuments() {
    this.log('debug', 'Starting getDocuments')
    let bills = []
    let files = []
    const documentsLines = document.querySelector('tbody').children
    for (const document of documentsLines) {
      const extractedDatas = await this.extractDatas(document)
      const computedFile = await this.computeDatas(extractedDatas)
      if (computedFile.documentType === 'Facture') {
        bills.push(computedFile)
      } else {
        files.push(computedFile)
      }
    }
    await Promise.all([
      this.sendToPilot({ bills }),
      this.sendToPilot({ files })
    ])
  }

  extractDatas(document) {
    this.log('debug', 'Stating extractDatas')
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
    this.log('debug', 'Starting computeDatas')
    const [rawDate, documentType, vendorRef, rawAmount, href] = datas
    const refContract = document.querySelector('.ref_ct').innerHTML
    const [day, month, year] = rawDate.replace(/ /g, '').split('/')
    const date = `${year}/${month}/${day}`
    const vendor = 'veolia'
    let [amount, currency] = rawAmount.split(' ')
    const computedFile = {
      date: new Date(date),
      documentType,
      vendorRef,
      vendor,
      fileurl: `https://www.service.eau.veolia.fr${href}`,
      fileAttributes: {
        metadata: {
          contentAuthor: 'veolia eau',
          datetime: new Date(date),
          datetimeLabel: 'issueDate',
          isSubscription: true,
          issueDate: new Date(),
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
