/**
 * PagSeguro Transparente para Magento
 * @author Ricardo Martins <ricardo@ricardomartins.net.br>
 * @link https://github.com/r-martins/PagSeguro-Magento-Transparente
 * @version 3.8.2
 */

RMPagSeguro = Class.create({
    initialize: function (config) {
        this.config = config;

        // initialize plugin classes
        this.initMiscPlugin();
        this.initMultiCcPlugin();

        if (!config.PagSeguroSessionId) {
            console.error('Falha ao obter sessão junto ao PagSeguro. Verifique suas credenciais, configurações e logs de erro.')
        }
        PagSeguroDirectPayment.setSessionId(config.PagSeguroSessionId);

        // this.updateSenderHash();
        PagSeguroDirectPayment.onSenderHashReady(this.updateSenderHash);

        if (typeof config.checkoutFormElm == "undefined") {
            var methods= $$('#p_method_rm_pagseguro_cc', '#p_method_pagseguropro_boleto', '#p_method_pagseguropro_tef');
            if(!methods.length){
                console.log('PagSeguro: Não há métodos de pagamento habilitados em exibição. Execução abortada.');
                return;
            }else{
                var form = methods.first().closest('form');
                form.observe('submit', function(e){
                    e.preventDefault();
                    e.stopPropagation();
                    RMPagSeguroObj.formElementAndSubmit = e.element();
                    RMPagSeguroObj.updateCreditCardToken();
                });
            }
        }

        if(config.PagSeguroSessionId == false){
            console.error('Não foi possível obter o SessionId do PagSeguro. Verifique seu token, chave e configurações.');
        }
        console.log('RMPagSeguro prototype class has been initialized.');

        this.maxSenderHashAttempts = 30;

        //internal control to avoid duplicated calls to updateCreditCardToken
        this.updatingCreditCardToken = false;
        this.formElementAndSubmit = false;


        Validation.add('validate-pagseguro', 'Falha ao atualizar dados do pagaento. Entre novamente com seus dados.',
            function(v, el){
                RMPagSeguroObj.updatePaymentHashes();
                return true;
        });
    },
    updateSenderHash: function(response) {
        if(typeof response === 'undefined'){
            PagSeguroDirectPayment.onSenderHashReady(RMPagSeguroObj.updateSenderHash);
            return false;
        }
        if(response.status == 'error'){
            console.log('PagSeguro: Falha ao obter o senderHash. ' + response.message);
            return false;
        }
        RMPagSeguroObj.senderHash = response.senderHash;
        RMPagSeguroObj.updatePaymentHashes();

        return true;
    },

    getInstallments: function(grandTotal, selectedInstallment){
        var brandName = "";
        if(typeof RMPagSeguroObj.brand == "undefined"){
            return;
        }
        if(!grandTotal){
            grandTotal = this.getGrandTotal();
            return;
        }
        this.grandTotal = grandTotal;
        brandName = RMPagSeguroObj.brand.name;

        var parcelsDrop = $('rm_pagseguro_cc_cc_installments');
        if(!selectedInstallment && parcelsDrop.value != ""){
            selectedInstallment = parcelsDrop.value.split('|').first();
        }
        PagSeguroDirectPayment.getInstallments({
            amount: grandTotal,
            brand: brandName,
            success: function(response) {
                for(installment in response.installments) break;
//                       console.log(response.installments);
//                 var responseBrand = Object.keys(response.installments)[0];
//                 var b = response.installments[responseBrand];
                var b = Object.values(response.installments)[0];
                parcelsDrop.length = 0;

                if(RMPagSeguroObj.config.force_installments_selection){
                    var option = document.createElement('option');
                    option.text = "Selecione a quantidade de parcelas";
                    option.value = "";
                    parcelsDrop.add(option);
                }

                var installment_limit = RMPagSeguroObj.config.installment_limit;
                for(var x=0; x < b.length; x++){
                    var option = document.createElement('option');
                    option.text = b[x].quantity + "x de R$" + b[x].installmentAmount.toFixed(2).toString().replace('.',',');
                    option.text += (b[x].interestFree)?" sem juros":" com juros";
                    if(RMPagSeguroObj.config.show_total){
                        option.text += " (total R$" + (b[x].installmentAmount*b[x].quantity).toFixed(2).toString().replace('.', ',') + ")";
                    }
                    option.selected = (b[x].quantity == selectedInstallment);
                    option.value = b[x].quantity + "|" + b[x].installmentAmount;
                    if (installment_limit != 0 && installment_limit <= x) {
                        break;
                    }
                    parcelsDrop.add(option);
                }
//                       console.log(b[0].quantity);
//                       console.log(b[0].installmentAmount);

            },
            error: function(response) {
                parcelsDrop.length = 0;

                var option = document.createElement('option');
                option.text = "1x de R$" + RMPagSeguroObj.grandTotal.toFixed(2).toString().replace('.',',') + " sem juros";
                option.selected = true;
                option.value = "1|" + RMPagSeguroObj.grandTotal.toFixed(2);
                parcelsDrop.add(option);

                var option = document.createElement('option');
                option.text = "Falha ao obter demais parcelas junto ao pagseguro";
                option.value = "";
                parcelsDrop.add(option);

                console.error('Somente uma parcela será exibida. Erro ao obter parcelas junto ao PagSeguro:');
                console.error(response);
            },
            complete: function(response) {
//                       console.log(response);
//                 RMPagSeguro.reCheckSenderHash();
            }
        });
    },

    /**
     * Update installments field on a specified card form
     * 
     * @param float grandTotal 
     * @param float cardFormIdx 
     */
    updateInstallments: function(grandTotal, cardFormIdx)
    {
        if(!grandTotal)
        {
            console.warn("Trying to calculate installments without grand total value.");
            return;
        }

        var cardBrand = this._getCardBrand(cardFormIdx);
        
        if(!cardBrand)
        {
            console.warn("Trying to calculate installments without card brand.");
            return;
        }

        var selectBox = this._clearInstallmentsSelectbox(cardFormIdx);
        selectBox.options[0].text = "Recalculando parcelas..."

        PagSeguroDirectPayment.getInstallments
        ({
            amount  : grandTotal,
            brand   : this._getCardBrand(cardFormIdx),
            success : this._populateInstallments.bind(this, cardFormIdx),
            error   : this._populateSafeInstallments.bind(this, cardFormIdx, grandTotal),
        });
    },

    /**
     * Callback function that populates installments
     * select box with returned options (consider multi cc)
     * 
     * @param integer cardFormIdx 
     * @param XMLHttpRequest response 
     */
    _populateInstallments: function(cardFormIdx, response)
    {
        var remoteInstallments = Object.values(response.installments)[0];
        var selectbox = this._clearInstallmentsSelectbox(cardFormIdx);

        if(this.config.force_installments_selection)
        {
            selectbox.options[0].text = "Selecione a quantidade de parcelas";
        }

        var maxInstallments = this.config.installment_limit;

        for(var x=0; x < remoteInstallments.length; x++)
        {
            var option = document.createElement('option');
            option.text = remoteInstallments[x].quantity + "x de R$" + remoteInstallments[x].installmentAmount.toFixed(2).toString().replace('.',',');
            option.text += (remoteInstallments[x].interestFree)?" sem juros":" com juros";
            
            if(this.config.show_total)
            {
                option.text += " (total R$" + (remoteInstallments[x].installmentAmount * remoteInstallments[x].quantity).toFixed(2).toString().replace('.', ',') + ")";
            }

            //option.selected = (remoteInstallments[x].quantity == selectedInstallments);
            option.value = remoteInstallments[x].quantity + "|" + remoteInstallments[x].installmentAmount;
            
            if (maxInstallments != 0 && maxInstallments <= x)
            {
                break;
            }

            selectbox.add(option);
        }
    },

    /**
     * Callback function that populates installments 
     * select box when there isn't a response from 
     * server (consider multi cc)
     * 
     * @param integer cardFormIdx 
     * @param float grandTotal 
     * @param XMLHttpRequest response 
     */
    _populateSafeInstallments: function(cardFormIdx, grandTotal, response)
    {
        var selectbox = this._clearInstallmentsSelectbox(cardFormIdx);
        selectbox.options[0].text = "Falha ao obter demais parcelas junto ao pagseguro";

        var option = document.createElement('option');
        option.text = "1x de R$" + grandTotal.toFixed(2).toString().replace('.',',') + " sem juros";
        option.selected = true;
        option.value = "1|" + grandTotal.toFixed(2);
        selectbox.add(option);

        console.error('Somente uma parcela será exibida. Erro ao obter parcelas junto ao PagSeguro:');
        console.error(response);
    },

    addCardFieldsObserver: function(obj){
        try {
            var ccNumElm = $$('input[name="payment[ps_cc_number]"]').first();
            var ccExpMoElm = $$('select[name="payment[ps_cc_exp_month]"]').first();
            var ccExpYrElm = $$('select[name="payment[ps_cc_exp_year]"]').first();
            var ccCvvElm = $$('input[name="payment[ps_cc_cid]"]').first();

            Element.observe(ccNumElm,'change',function(e){obj.updateCreditCardToken();});
            Element.observe(ccExpMoElm,'change',function(e){obj.updateCreditCardToken();});
            Element.observe(ccExpYrElm,'change',function(e){obj.updateCreditCardToken();});
            Element.observe(ccCvvElm,'change',function(e){obj.updateCreditCardToken();});
        }catch(e){
            console.error('Não foi possível adicionar observevação aos cartões. ' + e.message);
        }

    },
    updateCreditCardToken: function(){
        var ccNum = $$('input[name="payment[ps_cc_number]"]').first().value.replace(/^\s+|\s+$/g,'');
        // var ccNumElm = $$('input[name="payment[ps_cc_number]"]').first();
        var ccExpMo = $$('select[name="payment[ps_cc_exp_month]"]').first().value.replace(/^\s+|\s+$/g,'');
        var ccExpYr = $$('select[name="payment[ps_cc_exp_year]"]').first().value.replace(/^\s+|\s+$/g,'');
        var ccCvv = $$('input[name="payment[ps_cc_cid]"]').first().value.replace(/^\s+|\s+$/g,'');

        var brandName = '';
        if(typeof RMPagSeguroObj.lastCcNum != "undefined" || ccNum != RMPagSeguroObj.lastCcNum){
            this.updateBrand();
            if(typeof RMPagSeguroObj.brand != "undefined"){
                brandName = RMPagSeguroObj.brand.name;
            }
        }

        if(ccNum.length > 6 && ccExpMo != "" && ccExpYr != "" && ccCvv.length >= 3)
        {
            if(this.updatingCreditCardToken){
                return;
            }
            this.updatingCreditCardToken = true;

            RMPagSeguroObj.disablePlaceOrderButton();
            PagSeguroDirectPayment.createCardToken({
                cardNumber: ccNum,
                brand: brandName,
                cvv: ccCvv,
                expirationMonth: ccExpMo,
                expirationYear: ccExpYr,
                success: function(psresponse){
                    RMPagSeguroObj.creditCardToken = psresponse.card.token;
                    var formElementAndSubmit = RMPagSeguroObj.formElementAndSubmit;
                    RMPagSeguroObj.formElementAndSubmit = false;
                    RMPagSeguroObj.updatePaymentHashes(formElementAndSubmit);
                    $('card-msg').innerHTML = '';
                },
                error: function(psresponse){
                    if(undefined!=psresponse.errors["30400"]) {
                        $('card-msg').innerHTML = 'Dados do cartão inválidos.';
                    }else if(undefined!=psresponse.errors["10001"]){
                        $('card-msg').innerHTML = 'Tamanho do cartão inválido.';
                    }else if(undefined!=psresponse.errors["10002"]){
                        $('card-msg').innerHTML = 'Formato de data inválido';
                    }else if(undefined!=psresponse.errors["10003"]){
                        $('card-msg').innerHTML = 'Código de segurança inválido';
                    }else if(undefined!=psresponse.errors["10004"]){
                        $('card-msg').innerHTML = 'Código de segurança é obrigatório';
                    }else if(undefined!=psresponse.errors["10006"]){
                        $('card-msg').innerHTML = 'Tamanho do Código de segurança inválido';
                    }else if(undefined!=psresponse.errors["30405"]){
                        $('card-msg').innerHTML = 'Data de validade incorreta.';
                    }else if(undefined!=psresponse.errors["30403"]){
                        RMPagSeguroObj.updateSessionId(); //Se sessao expirar, atualizamos a session
                    }else if(undefined!=psresponse.errors["20000"]){ // request error (pagseguro fora?)
                        console.log('Erro 20000 no PagSeguro. Tentando novamente...');
                        RMPagSeguroObj.updateCreditCardToken(); //tenta de novo
                    }else{
                        console.log('Resposta PagSeguro (dados do cartao incorrreto):');
                        console.log(psresponse);
                        $('card-msg').innerHTML = 'Verifique os dados do cartão digitado.';
                    }
                    console.error('Falha ao obter o token do cartao.');
                    console.log(psresponse.errors);
                },
                complete: function(psresponse){
                    RMPagSeguroObj.updatingCreditCardToken = false;
                    RMPagSeguroObj.enablePlaceOrderButton();
                    if(RMPagSeguroObj.config.debug){
                        console.info('Card token updated successfully.');
                    }
                },
            });
        }
        if(typeof RMPagSeguroObj.brand != "undefined") {
            this.getInstallments();
        }
    },
    _getCardBrand: function(cardFormIdx = 1)
    {
        if(cardFormIdx == 1 && this.brand)
        {
            return this.brand.name;
        }

        if(cardFormIdx == 2 && this.brand2)
        {
            return this.brand2.name;
        }

        return false;
    },
    updateBrand: function(){
        var ccNum = $$('input[name="payment[ps_cc_number]"]').first().value.replace(/^\s+|\s+$/g,'');
        var currentBin = ccNum.substring(0, 6);
        var flag = RMPagSeguroObj.config.flag; //tamanho da bandeira

        if(ccNum.length >= 6){
            if (typeof RMPagSeguroObj.cardBin != "undefined" && currentBin == RMPagSeguroObj.cardBin) {
                if(typeof RMPagSeguroObj.brand != "undefined"){
                    $('card-brand').innerHTML = '<img src="https://stc.pagseguro.uol.com.br/public/img/payment-methods-flags/' +flag + '/' + RMPagSeguroObj.brand.name + '.png" alt="' + RMPagSeguroObj.brand.name + '" title="' + RMPagSeguroObj.brand.name + '"/>';
                }
                return;
            }
            RMPagSeguroObj.cardBin = ccNum.substring(0, 6);
            PagSeguroDirectPayment.getBrand({
                cardBin: currentBin,
                success: function(psresponse){
                    RMPagSeguroObj.brand = psresponse.brand;
                    $('card-brand').innerHTML = psresponse.brand.name;
                    if(RMPagSeguroObj.config.flag != ''){

                        $('card-brand').innerHTML = '<img src="https://stc.pagseguro.uol.com.br/public/img/payment-methods-flags/' +flag + '/' + psresponse.brand.name + '.png" alt="' + psresponse.brand.name + '" title="' + psresponse.brand.name + '"/>';
                    }
                    $('card-brand').className = psresponse.brand.name.replace(/[^a-zA-Z]*!/g,'');
                },
                error: function(psresponse){
                    console.error('Falha ao obter bandeira do cartão.');
                    if(RMPagSeguroObj.config.debug){
                        console.debug('Verifique a chamada para /getBin em df.uol.com.br no seu inspetor de Network a fim de obter mais detalhes.');
                    }
                }
            })
        }
    },
    disablePlaceOrderButton: function(){
        if (RMPagSeguroObj.config.placeorder_button) {
            if(typeof $$(RMPagSeguroObj.config.placeorder_button).first() != 'undefined'){
                $$(RMPagSeguroObj.config.placeorder_button).first().up().insert({
                    'after': new Element('div',{
                        'id': 'pagseguro-loader'
                    })
                });

                $$('#pagseguro-loader').first().setStyle({
                    'background': '#000000a1 url(\'' + RMPagSeguroObj.config.loader_url + '\') no-repeat center',
                    'height': $$(RMPagSeguroObj.config.placeorder_button).first().getStyle('height'),
                    'width': $$(RMPagSeguroObj.config.placeorder_button).first().getStyle('width'),
                    'left': document.querySelector(RMPagSeguroObj.config.placeorder_button).offsetLeft + 'px',
                    'z-index': 99,
                    'opacity': .5,
                    'position': 'absolute',
                    'top': document.querySelector(RMPagSeguroObj.config.placeorder_button).offsetTop + 'px'
                });
                // $$(RMPagSeguroObj.config.placeorder_button).first().disable();
                return;
            }

            if(RMPagSeguroObj.config.debug){
                console.error('PagSeguro: Botão configurado não encontrado (' + RMPagSeguroObj.config.placeorder_button + '). Verifique as configurações do módulo.');
            }
        }
    },
    enablePlaceOrderButton: function(){
        if(RMPagSeguroObj.config.placeorder_button && typeof $$(RMPagSeguroObj.config.placeorder_button).first() != 'undefined'){
            $$('#pagseguro-loader').first().remove();
            // $$(RMPagSeguroObj.config.placeorder_button).first().enable();
        }
    },
    updatePaymentHashes: function(formElementAndSubmit=false){
        var _url = RMPagSeguroSiteBaseURL + 'pseguro/ajax/updatePaymentHashes';
        var _paymentHashes = {
            "payment[sender_hash]": this.senderHash,
            "payment[credit_card_token]": this.creditCardToken,
            "payment[cc_type]": (this.brand)?this.brand.name:'',
            "payment[is_admin]": this.config.is_admin
        };
        new Ajax.Request(_url, {
            method: 'post',
            parameters: _paymentHashes,
            onSuccess: function(response){
                if(RMPagSeguroObj.config.debug){
                    console.debug('Hashes atualizados com sucesso.');
                    console.debug(_paymentHashes);
                }
            },
            onFailure: function(response){
                if(RMPagSeguroObj.config.debug){
                    console.error('Falha ao atualizar os hashes da sessão.');
                    console.error(response);
                }
                return false;
            }
        });
        if(formElementAndSubmit){
            formElementAndSubmit.submit();
        }
    },
    getGrandTotal: function(callbackFunction = null){
        if(this.config.is_admin){
            return this.grandTotal;
        }
        var _url = RMPagSeguroSiteBaseURL + 'pseguro/ajax/getGrandTotal';
        new Ajax.Request(_url,
        {
            onSuccess: (function(response)
            {
                this.grandTotal =  response.responseJSON.total;

                if(callbackFunction)
                {
                    callbackFunction(this.grandTotal);
                }

                // RMPagSeguroObj.getInstallments(RMPagSeguroObj.grandTotal);
            }).bind(this),
            onFailure: function(response)
            {
                return false;
            }
        });
    },
    removeUnavailableBanks: function() {
        if (RMPagSeguroObj.config.active_methods.tef) {
            if($('pseguro_tef_bank').nodeName != "SELECT"){
                //se houve customizações no elemento dropdown de bancos, não selecionaremos aqui
                return;
            }
            PagSeguroDirectPayment.getPaymentMethods({
                amount: RMPagSeguroObj.grandTotal,
                success: function (response) {
                    if (response.error == true && RMPagSeguroObj.config.debug) {
                        console.log('Não foi possível obter os meios de pagamento que estão funcionando no momento.');
                        return;
                    }
                    if (RMPagSeguroObj.config.debug) {
                        console.log(response.paymentMethods);
                    }

                    try {
                        $('pseguro_tef_bank').options.length = 0;
                        for (y in response.paymentMethods.ONLINE_DEBIT.options) {
                            if (response.paymentMethods.ONLINE_DEBIT.options[y].status != 'UNAVAILABLE') {
                                var optName = response.paymentMethods.ONLINE_DEBIT.options[y].displayName.toString();
                                var optValue = response.paymentMethods.ONLINE_DEBIT.options[y].name.toString();

                                var optElm = new Element('option', {value: optValue}).update(optName);
                                $('pseguro_tef_bank').insert(optElm);
                            }
                        }

                        if(RMPagSeguroObj.config.debug){
                            console.info('Bancos TEF atualizados com sucesso.');
                        }
                    } catch (err) {
                        console.log(err.message);
                    }
                }
            })
        }
    },
    updateSessionId: function() {
        var _url = RMPagSeguroSiteBaseURL + 'pseguro/ajax/getSessionId';
        new Ajax.Request(_url, {
            onSuccess: function (response) {
                var session_id = response.responseJSON.session_id;
                if(!session_id){
                    console.log('Não foi possível obter a session id do PagSeguro. Verifique suas configurações.');
                }
                PagSeguroDirectPayment.setSessionId(session_id);
            }
        });
    },


    /**
     * Initialize miscellaneous plugin: class with
     * methods thats helps to manipulate DOM elements
     * of the payment form
     */
    initMiscPlugin: function()
    {
        this.miscPlugin = new RMPagSeguro_MiscellaneousPlugin
        ({
            "object": this
        });
    },

    /**
     * Initialize multi credit card plugin
     */
    initMultiCcPlugin: function()
    {
        if(this._isMultiCcPluginAvailable())
        {
            this.multiCcPlugin = new RMPagSeguro_MultiCcPlugin
            ({
                "object": this
            });
        }
    },

    /**
     * Checks if multi cc plugin is enabled on 
     * Magento config
     */
    _isMultiCcPluginAvailable: function()
    {
        return this.config.is_multicc_enabled;
    },
    
    /**
     * Remove all options from installments select box,
     * except the one with empty value (consider multi cc)
     * 
     * @param integer cardFormIdx 
     */
    _clearInstallmentsSelectbox(cardFormIdx)
    {
        var selectBox = this.miscPlugin.getInstallmentsFieldForCard(cardFormIdx);

        for(var i = 0; i < selectBox.length; i++)
        {
            if(selectBox.options[i].value != "")
            {
                selectBox.remove(i);
                i--;
            }
        }

        return selectBox;
    },

    /**
     * This function is a replacement of updateBrand
     */
    _homolog__updateBrand(cardFormIdx = 1)
    {
        var cardNumber = this._getCardNumber(cardFormIdx);

        // if card has at least 6 digits, its able 
        // to be classified as some brand
        if(cardNumber.length >= 6)
        {
            // try to avoid ajax getting the local variable
            var brandDomElement = this.miscPlugin.getCardBrandElement(cardFormIdx);

            if(cardFormIdx == 1 && this.cardBin && this.brand)
            {
                brandDomElement.innerHTML = '<img src="https://stc.pagseguro.uol.com.br/public/img/payment-methods-flags/' + this.config.flag + '/' + this.brand.name + '.png" alt="' + this.brand.name + '" title="' + this.brand.name + '"/>';
            }

            if(cardFormIdx == 2 && this.card2Bin && this.brand2)
            {
                brandDomElement.innerHTML = '<img src="https://stc.pagseguro.uol.com.br/public/img/payment-methods-flags/' + this.config.flag + '/' + this.brand2.name + '.png" alt="' + this.brand2.name + '" title="' + this.brand2.name + '"/>';
            }

            // update localy the card bin
            if(cardFormIdx == 1) { this.cardBin = cardNumber.substring(0, 6); }
            if(cardFormIdx == 2) { this.card2Bin = cardNumber.substring(0, 6); }

            PagSeguroDirectPayment.getBrand
            ({
                cardBin : cardNumber.substring(0, 6),
                success : this._homolog__updateBrandPostback.bind(this, cardFormIdx),
                error   : this._homolog__updateBrandPostbackError.bind(this)
            });
        }
    },

    _homolog__updateBrandPostback: function(cardFormIdx, response)
    {
        if(cardFormIdx == 1) { this.brand = response.brand; }
        if(cardFormIdx == 2) { this.brand2 = response.brand; }
        
        var brandDomElement = this.miscPlugin.getCardBrandElement(cardFormIdx);
        brandDomElement.innerHTML = response.brand.name;

        if(this.config.flag != '')
        {
            brandDomElement.innerHTML = '<img src="https://stc.pagseguro.uol.com.br/public/img/payment-methods-flags/' + this.config.flag + '/' + response.brand.name + '.png" alt="' + response.brand.name + '" title="' + response.brand.name + '"/>';
        }

        brandDomElement.classname = response.brand.name.replace(/[^a-zA-Z]*!/g,'');
    },

    _homolog__updateBrandPostbackError: function(response)
    {
        console.error('Falha ao obter bandeira do cartão.');
        
        if(this.config.debug)
        {
            console.debug('Verifique a chamada para /getBin em df.uol.com.br no seu inspetor de Network a fim de obter mais detalhes.');
        }
    },

    _getCardNumber: function(cardFormIdx)
    {
        var field = this.miscPlugin._getCardNumberField(cardFormIdx);

        if(field)
        {
            return field.getValue();
        }

        return "";
    }
});


RMPagSeguro_MultiCcPlugin = Class.create
({
    initialize: function (config)
    {
        this.paymentMethodCode = "rm_pagseguro_cc";
        this.parentObject = config.object;
        this.miscPlugin = config.object.miscPlugin;
        this.forcedValidationFailure = false;
        

        this._setupMageFormValidation();
        this._setupStaticObservers();
    },

    /**
     * Add validation class to Magento 
     */
    _setupMageFormValidation: function()
    {
        var self = this;

        var gtZeroMessage = "O valor informado deve ser maior do que 0.";
        var ltGrandTotal = "O valor informado deve ser menor do que o total do pedido.";

        Validation.add("rm-pagseguro-multicc-gt-0", gtZeroMessage, function(v, el)
        {
            if(v <= 0)
            {
                return false;
            }

            return true;
        });

        Validation.add("rm-pagseguro-multicc-lt-grand-total", ltGrandTotal, function(v, el)
        {
            if(self.forcedValidationFailure)
            {
                return false;
            }

            return true;
        });
    },

    /**
     * Add form fields observers to controls
     * the payment flow
     */
    _setupStaticObservers: function()
    {
        // use multi cc switch
        $(this.paymentMethodCode + "_multicc").observe("change", (function(event)
        {
            var checkbox = event.currentTarget;
            checkbox.checked 
                ? this._enable() 
                : this._disable();
            
        }).bind(this));
        
        // format cc1 total value
        this.miscPlugin.
            getTotalValueFieldForCard(1).
            observe("keyup", this._formatCurrencyInput);
        
        // [go to first form] link
        $(this.paymentMethodCode + "_cc1_summary_info").observe("click", (function(event)
        {
            this._updateProgressBar(this.grandTotal, this._getTotalValueForCard(1));
            this._showCardGroupForm(1);
        }).bind(this));

        // [go to second form] button
        $(this.paymentMethodCode + "_add_second_cc_button").observe("click", (function(event)
        {
            if(this._isCardFormValid(1))
            {
                this._updateProgressBar(1, 1); // <= set progress complete
                this._showCardGroupForm(2);
            }
        }).bind(this));

        // update brand after change card (form 2) number
        this.miscPlugin._getCardNumberField(2).observe
        (
            "change", 
            this.parentObject._homolog__updateBrand.bind(this.parentObject, 2)
        );
    },

    /**
     * Initialize observers that must be removed
     * when the plugin is disabled - dynamic observers
     */
    _createDynObservers: function()
    {
        var validationClasses = "required-entry " + 
                                "rm-pagseguro-multicc-gt-0 " + 
                                "rm-pagseguro-multicc-lt-grand-total";
        
        
        // observe fulfillment of total value for 
        // first card, to update the value for the 
        // second one
        var cc1TotalValueField = this.miscPlugin.getTotalValueFieldForCard(1);
        cc1TotalValueField.addClassName(validationClasses);

        // this property is a reference to the 
        // binded method (used to unbind when necessary)
        this._updateTotalsAndInstallmentsMethod = (function(event)
        {
            // reset force validation failure to 
            // revalidate the grand total value
            this.forcedValidationFailure = false;
            this._updateTotalsAndInstallments($(event.currentTarget));
        }).bind(this);
        
        cc1TotalValueField.observe("change", this._updateTotalsAndInstallmentsMethod);
    },

    /**
     * Disable dynamic observers
     */
    _destroyDynObservers: function()
    {
        // disable first card total value field observer
        var cc1TotalValueField = this.miscPlugin.getTotalValueFieldForCard(1);
        cc1TotalValueField.removeClassName("required-entry");
        
        if(this._updateTotalsAndInstallmentsMethod)
        {
            cc1TotalValueField.stopObserving("change", this._updateTotalsAndInstallmentsMethod);
            this._updateTotalsAndInstallmentsMethod = null;
        }
    },

    /**
     * Enable / disable multi cc payment
     */
    _enable: function()
    {
        // reset first card form as the active one
        this.activeForm = 1;

        this._showMultiCcFields();
        this._createDynObservers();
        this._updateProgressBar(1, 0); // review later !!!
    },
    _disable: function()
    {
        this._hideMultiCcFields();
        this._destroyDynObservers();
        this.getGrandTotal(); // review later !!!
    },

    /**
     * Show / hide multi cc form specific fields 
     */
    _showMultiCcFields: function()
    {
        $$("li[data-role=multi-cc-form-field]").each(Element.show);
    },
    _hideMultiCcFields: function()
    {
        $$("li[data-role=multi-cc-form-field]").each(Element.hide);
    },

    /**
     * Request grand total value from server and update
     * paid value fields and installments
     */
    _updateTotalsAndInstallments: function()
    {
        var firstCardTotal = this._getTotalValueForCard(1);
        var secondCardTotal = this._getTotalValueForCard(2);

        this.parentObject.getGrandTotal((function(grandTotal)
        {
            this._validateFirstCardTotal(grandTotal, firstCardTotal);
            this._syncCardTotalValues(grandTotal, firstCardTotal);
            this._updateProgressBar(grandTotal, firstCardTotal);

            if(firstCardTotal > 0)
            {
                this.parentObject.updateInstallments(firstCardTotal, 1);
            }

            if(secondCardTotal > 0)
            {
                this.parentObject.updateInstallments(secondCardTotal, 2);
            }

        }).bind(this));
    },


    /**
     * Update progress bar based on value of totals for
     * each card
     * 
     * @param float grandTotal 
     * @param float firstCardTotal 
     * @param float secondCardTotal 
     */
    _updateProgressBar: function(grandTotal, paidTotal)
    {
        var paidPercent = paidTotal * 100 / grandTotal;
        this.miscPlugin.getProgressBarField().setStyle
        ({
            "width": paidPercent.toFixed(2) + "%"
        });
    },

    /**
     * Update total field for second card, based on
     * grand total and first card total field
     * 
     * @param float grandTotal 
     * @param float firstCardTotal 
     */
    _syncCardTotalValues: function(grandTotal, firstCardTotal)
    {
        this._setTotalValueForCard(2, grandTotal - firstCardTotal);
    },

    /**
     * Verify if the inserted value is inside 
     * the allowed range
     * 
     * @param float grandTotal 
     * @param float firstCardTotal 
     */
    _validateFirstCardTotal: function(grandTotal, firstCardTotal)
    {
        if(grandTotal <= firstCardTotal)
        {
            this.forcedValidationFailure = true;
        }

        var inputField = this.miscPlugin.getTotalValueFieldForCard(1);
        Validation.validate(inputField);
    },

    /**
     * Validate card form, given the form ID
     * 
     * @param integer cardFormIdx 
     */
    _isCardFormValid: function(cardFormIdx)
    {
        var valid = true;
        
        this.miscPlugin
            .getCardFormInputsAndSelects(cardFormIdx)
            .each(function(element)
            {
                if($(element).readAttribute("name"))
                {
                    valid &= Validation.validate(element);
                }
            });

        return valid;
    },

    /**
     * Show credit card form, given its ID
     * 
     * @param integer cardFormIdx 
     */
    _showCardGroupForm: function(cardFormIdx)
    {
        if(cardFormIdx == 1)
        {
            this.miscPlugin.getFirstCardFormButton().each(Element.show);
            this.miscPlugin.getFirstCardTotalLine().each(Element.show);
        }
        else
        {
            this.miscPlugin.getFirstCardFormButton().each(Element.hide);
            this.miscPlugin.getFirstCardTotalLine().each(Element.hide);
        }

        this.miscPlugin.getCardFormLines().each(Element.hide);
        this.miscPlugin.getCardFormLines(cardFormIdx).each(Element.show);
    },

    /**
     * Get the total value to be paid by a card, 
     * given its form ID
     * 
     * @param integer cardFormIdx 
     */
    _getTotalValueForCard: function(cardFormIdx)
    {
        var inputField = this.miscPlugin.getTotalValueFieldForCard(cardFormIdx);
        return parseFloat(inputField.getValue());
    },

    /**
     * Set the total value to be paid by a card, 
     * given its form ID
     * 
     * @param integer cardFormIdx 
     * @param float|string value 
     */
    _setTotalValueForCard: function(cardFormIdx, value)
    {
        var inputField = this.miscPlugin.getTotalValueFieldForCard(cardFormIdx);
        inputField.setValue(value);
    },





















    

    _validateCardForm(cardFormIdx)
    {
        return false;
    },

    _formatCurrencyInput: function(event)
    {
        var formattedValue = $(this).getValue().replace(/\D/g,'');
            
        while(formattedValue.length > 0 && formattedValue.substring(0, 1) == 0)
        {
            formattedValue = formattedValue.substring(1);
        }

        if(formattedValue.length == 1)
        {
            formattedValue = "0,0" + formattedValue;
        }
        else if(formattedValue.length == 2)
        {
            formattedValue = "0," + formattedValue;
        }
        else if(formattedValue.length > 2)
        {
            formattedValue = formattedValue.substring(0, formattedValue.length - 2) + 
                             "," + 
                             formattedValue.substring(formattedValue.length - 2);
        }
        
        $(this).setValue(formattedValue);
    }
});


RMPagSeguro_MiscellaneousPlugin = Class.create
({
    initialize: function(config)
    {
        this.parentObject = config.object;
        this.paymentMethodCode = "rm_pagseguro_cc";
    },

    /**
     * Get progress bar DOM element
     */
    getProgressBarField: function()
    {
        var field = $(this.paymentMethodCode + "_multi_cc_progress_bar")
                        .select("[data-role=progress]");

        return $(field.first());
    },

    /**
     * Get installments selecto box DOM element,
     * given the card form ID
     */
    getInstallmentsFieldForCard: function(cardFormIdx = 1)
    {
        var fieldId = this.paymentMethodCode + 
                      "_cc" + this._getCardSuffix(cardFormIdx) + 
                      "_installments";
        
        return $(fieldId);
    },

    /**
     * Get total value DOM element, given the card 
     * form ID
     */
    getTotalValueFieldForCard: function(cardFormIdx)
    {
        var fieldId = this.paymentMethodCode + 
                      "_cc" + this._getCardSuffix(cardFormIdx) + 
                      "_total_value";
        
        return $(fieldId);
    },

    _getCardNumberField(cardFormIdx)
    {
        var fieldId = this.paymentMethodCode + 
                      "_cc" + this._getCardSuffix(cardFormIdx) + 
                      "_number";
        
        return $(fieldId);
    },

    _getCardSuffix(cardFormIdx)
    {
        if(Number.isInteger(cardFormIdx))
        {
            cardFormIdx = cardFormIdx.toString();
        }

        return cardFormIdx == "1" ? "" : cardFormIdx;
    },

    getCardFormInputsAndSelects(cardFormIdx)
    {
        return $$
        (
            "li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "] input[type=text]",
            "li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "] input[type=number]",
            "li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "] input[type=tel]",
            "li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "] input[type=email]",
            "li[data-role=multi-cc-form-field] input[type=text]",
            "li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "] select"
        );
    },

    getCardFormLines(cardFormIdx = false)
    {
        if(!cardFormIdx)
        {
            return $$("li[data-role=card-form-field]");
        }

        return $$("li[data-role=card-form-field][data-cc-form-idx=" + cardFormIdx + "]");
    },

    getFirstCardFormButton()
    {
        return $$("li[data-role=multi-cc-form-field].action-line.cc-1");
    },

    getFirstCardTotalLine()
    {
        return $$("li[data-role=multi-cc-form-field].total-value.cc-1");
    },

    getCardBrandElement(cardFormIdx = 1)
    {
        return $("card" + this._getCardSuffix(cardFormIdx) + "-brand");
    }
});